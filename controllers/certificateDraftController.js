//controllers/certificateDraftController.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { generateDocxFile, generateDocxBuffer } = require('../helpers/docx');
const azureBlobService = require('../services/azureBlobService');
const { notifyAndStore } = require('../lib/notifications/notifier');

const { extractCertFieldsFromOCR } = require('../helpers/openaiCertExtractor');

const mongoose = require('mongoose');

const User = require('../models/user'); // ha még nincs bent
const upload = multer({ dest: 'uploads/' });
const DraftCertificate = require('../models/draftCertificate.js');

// Notifications infra (shared)

/* ===== Single-concurrency processing queue (max 1 concurrent) ===== */
const PROCESS_CONCURRENCY = 1;
let activeProcesses = 0;
const processQueue = []; // items: { uploadId, resolve, reject }
const inFlight = new Set(); // uploadIds currently being processed
const queuedIds = new Set(); // uploadIds queued to avoid duplicates

function runNextProcess() {
  if (activeProcesses >= PROCESS_CONCURRENCY) return;
  const next = processQueue.shift();
  if (!next) return;

  const { uploadId, resolve, reject } = next;
  queuedIds.delete(uploadId);
  inFlight.add(uploadId);
  activeProcesses++;

  _processDraftsInternal(uploadId)
    .then((result) => resolve(result))
    .catch((err) => reject(err))
    .finally(() => {
      activeProcesses--;
      inFlight.delete(uploadId);
      runNextProcess();
    });
}

function enqueueProcess(uploadId) {
  // avoid duplicate queueing for the same uploadId
  if (inFlight.has(uploadId) || queuedIds.has(uploadId)) {
    return { alreadyQueuedOrRunning: true, position: null };
  }
  return new Promise((resolve, reject) => {
    processQueue.push({ uploadId, resolve, reject });
    queuedIds.add(uploadId);
    runNextProcess();
  });
}
/* ===== End of queue block ===== */

// ---- simple concurrency-limited promise pool (no external deps) ----
async function promisePool(items, limit, worker) {
  let i = 0;
  const results = new Array(items.length);
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}
// -------------------------------------------------------------------

// ---- transient error retry helper (exponential backoff + jitter) ----
function shouldRetryOpenAI(err) {
  const msg = (err && (err.message || err.toString())) || '';
  // common transient markers: 429/5xx/upstream/connect/timeouts/resets
  return /\b(429|5\d\d|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b/i.test(msg)
      || /upstream connect error/i.test(msg)
      || /connection (timeout|terminated|reset)/i.test(msg)
      || /temporarily unavailable/i.test(msg)
      || /timeout of \d+ms exceeded/i.test(msg)
      || /\brequest timed out\b/i.test(msg)
      || /\bdeadline exceeded\b/i.test(msg)
      || /\btimeout\b/i.test(msg);
}

async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = parseInt(process.env.OPENAI_RETRY_ATTEMPTS || '5', 10),
    baseMs = parseInt(process.env.OPENAI_RETRY_BASE_MS || '500', 10),
    factor = 2,
    maxDelayMs = parseInt(process.env.OPENAI_RETRY_MAX_MS || '5000', 10),
    jitter = 0.2,
    label = 'openai-call',
    isRetryable = shouldRetryOpenAI,
    onRetry = (e, attempt, delay) => {
      try { console.warn(`[retry:${label}] attempt ${attempt} failed:`, e?.message || e); } catch {}
    }
  } = opts;

  let attempt = 0;
  // first try immediately, then retry up to `retries` times
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries || !isRetryable(e)) {
        throw e;
      }
      const exp = Math.min(maxDelayMs, Math.round(baseMs * Math.pow(factor, attempt - 1)));
      const jitterDelta = exp * jitter;
      const delay = Math.max(0, Math.round(exp + (Math.random() * 2 - 1) * jitterDelta));
      onRetry(e, attempt, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
// --------------------------------------------------------------------

// ---- blob move with incrementing version suffix (_2, _3, ...) ----
async function moveBlobWithVersioning(srcPath, baseName, ext) {
  try { if (!srcPath) return null; } catch {}
  const cleanBase = String(baseName || '').trim().replace(/\.pdf$/i, '').replace(/\.docx$/i, '');
  const cleanExt = String(ext || '').replace(/^\./, '').toLowerCase();
  const makeDest = (b) => `certificates/${b}/${b}.${cleanExt}`;

  // target without version
  let targetBase = cleanBase;
  let dest = makeDest(targetBase);

  if (srcPath === dest) return dest; // already at final place

  // first try plain move
  try {
    await azureBlobService.renameFile(srcPath, dest);
    return dest;
  } catch (e) {
    console.warn(`⚠️ Blob rename failed ${srcPath} -> ${dest}: ${e?.message || e}`);
  }

  // incrementing version suffix
  for (let n = 2; n <= 99; n++) {
    const vBase = `${cleanBase}_${n}`;
    const vDest = makeDest(vBase);
    try {
      await azureBlobService.renameFile(srcPath, vDest);
      console.warn(`⚠️ Target existed; stored as versioned name: ${vDest}`);
      return vDest;
    } catch (e2) {
      // continue to next version
      console.warn(`⚠️ Blob rename (try _${n}) failed ${srcPath} -> ${vDest}: ${e2?.message || e2}`);
    }
  }

  // Give up: leave src in place so process doesn't fail
  console.warn(`⚠️ Could not move blob to any versioned destination for base="${cleanBase}", ext="${cleanExt}". Keeping source: ${srcPath}`);
  return srcPath;
}
// ------------------------------------------------------------------

// ---- local FS cleanup helpers ----
function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
function removeDraftFolderIfEmpty(uploadId) {
  const dir = path.join('storage', 'certificates', 'draft', uploadId);
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      if (files.length === 0) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

// ---- blob download via SAS (no SDK dependency here) ----
function downloadHttpsToBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function downloadBlobToBufferViaSAS(blobPath, ttlSeconds = 600) {
  const sasUrl = await azureBlobService.getReadSasUrl(blobPath, ttlSeconds);
  return await downloadHttpsToBuffer(sasUrl);
}
// -------------------------------------------------------------------


// 🔹 POST /api/certificates/bulk-upload
exports.bulkUpload = [
  upload.array('files', 20), // max 100
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      // 🔹 1. Létrehozzuk az uploadId-t
      const uploadId = `${Date.now()}-${uuidv4().slice(0, 6)}`;
      // tenant/user scope from auth
      const tenantId = req.scope?.tenantId;
      const ownerUserId = req.scope?.userId || req.userId || null;
      if (!tenantId || !ownerUserId) {
        return res.status(403).json({ error: 'Missing tenantId or user from auth' });
      }
      const createdBy = ownerUserId;

      // 🔹 2. Közvetlen blob-feltöltés (nincs lokális storage)
      for (const file of req.files) {
        // 🔹 2. Közvetlen blob-feltöltés (nincs lokális storage)
        const blobFolder = `certificates/uploads/${uploadId}`;
        const blobPdfPath = `${blobFolder}/${file.originalname}`;
        try {
          await azureBlobService.uploadFile(file.path, blobPdfPath);
        } catch (e) {
          console.warn(`⚠️ Blob upload failed for ${file.originalname}:`, e.message);
        } finally {
          // töröljük a multer ideiglenes fájlt
          try { if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
        }

        // 🔹 3. Mentés az ideiglenes DB-be (lokális elérési útvonalak nélkül)
        await DraftCertificate.create({
          tenantId,
          uploadId,
          fileName: file.originalname,
          originalPdfPath: null,     // nincs lokális storage
          status: 'draft',
          createdBy,
          blobPdfPath               // elmentjük a blob útvonalat
        });
      }

      res.status(200).json({ message: 'Files uploaded successfully', uploadId });
    } catch (err) {
      console.error('❌ Bulk upload error:', err);
      res.status(500).json({ error: 'Failed to upload files' });
    }
  }
];

// Internal helper for actual processing logic (not Express handler)
async function _processDraftsInternal(uploadId) {
  try {
    const drafts = await DraftCertificate.find({ uploadId });
    if (drafts.length === 0) {
      throw new Error('No drafts found for this uploadId');
    }
    // max párhuzamos feldolgozás (környezeti változóval felülírható)
    const FILE_CONCURRENCY = parseInt(process.env.CERT_FILE_CONCURRENCY || '4', 10);

    await promisePool(drafts, FILE_CONCURRENCY, async (draft) => {
      try {
        // 1) OCR közvetlenül SAS URL-ről (nincs buffer letöltés), buffer fallback-kal
        let recognizedText;
        if (draft.blobPdfPath) {
          const sasUrl = await azureBlobService.getReadSasUrl(draft.blobPdfPath, { ttlSeconds: 600 });
          const res = await retryWithBackoff(
            () => uploadPdfWithFormRecognizerInternal({ sourceUrl: sasUrl }),
            { label: 'formRecognizer-url' }
          );
          recognizedText = res.recognizedText;
        } else if (draft.originalPdfPath && fs.existsSync(draft.originalPdfPath)) {
          // Fallback: ha valamiért nincs blob (ritka)
          const buf = fs.readFileSync(draft.originalPdfPath);
          const res = await retryWithBackoff(
            () => uploadPdfWithFormRecognizerInternal(buf),
            { label: 'formRecognizer-buffer-fallback' }
          );
          recognizedText = res.recognizedText;
        } else {
          throw new Error('No PDF source found for OCR (blobPdfPath and originalPdfPath both missing)');
        }

        // 2) OpenAI kivonat (backoff + hosszabb timeout a helperben)
        const extractedData = await retryWithBackoff(
          () => extractCertFieldsFromOCR(recognizedText),
          { label: 'extractCertFieldsFromOCR' }
        );

        // 3) DOCX (buffer → blob) – kerüljük a lemezt a controllerben
        const originalFileName = draft.fileName.replace(/\.pdf$/i, '');
        const docxFileName = `${originalFileName}.docx`;
        let blobDocxPath = null;
        try {
          const docxBuffer = await generateDocxBuffer(recognizedText, originalFileName, extractedData?.scheme || 'ATEX');
          const blobFolder = `certificates/uploads/${draft.uploadId}`;
          blobDocxPath = `${blobFolder}/${docxFileName}`;
          await azureBlobService.uploadBuffer(
            blobDocxPath,
            docxBuffer,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          );
        } catch (e) {
          console.warn(`⚠️ Blob DOCX upload (buffer) failed for ${draft.fileName}:`, e.message);
        }

        // 5) Mentés (lokális docxPath nélkül)
        draft.recognizedText = recognizedText;
        draft.extractedData = extractedData;
        draft.docxPath = null;           // nincs lokális storage
        draft.blobDocxPath = blobDocxPath;
        draft.status = 'ready';
        await draft.save();

        console.log(`✅ Feldolgozva: ${draft.fileName}`);
      } catch (err) {
        console.warn(`⚠️ Hiba a fájl feldolgozásában (${draft.fileName}):`, err.message);
        draft.status = 'error';
        await draft.save();
      }
    });

    // ==== ÉRTESÍTÉS: ha minden fájl (ready+error) lefutott az uploadban ====
    const oneDraft = await DraftCertificate.findOne({ uploadId });
    const userId = (oneDraft?.createdBy || drafts[0]?.createdBy || null);

    const agg = await DraftCertificate.aggregate([
      { $match: { uploadId } },
      {
        $group: {
          _id: '$uploadId',
          total: { $sum: 1 },
          ready: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
          draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
          error: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        }
      }
    ]);

    const { total = 0, ready = 0, draft = 0, error = 0 } = agg[0] || {};
    const finished = total > 0 && (ready + error === total);

    if (finished && userId) {
      const title = 'Bulk processing finished';
      const message = `Upload ${uploadId}: ${ready} ready, ${error} error.`;

      await notifyAndStore(userId.toString(), {
        type: 'bulk-finished',
        title,
        message,
        data: { uploadId, total, ready, error },
        meta: {
          route: '/cert',
          query: { tab: 'upload', uploadId }
        },
        audience: 'user'
      });

      console.log(`Bulk processing finished for uploadId=${uploadId}: ${ready} ready, ${error} error, total ${total}`);
    }

    return { message: 'Feldolgozás kész', uploadId };
  } catch (err) {
    console.error('❌ Feldolgozás hiba:', err.message);
    throw err;
  }
}

exports.processDrafts = async (req, res) => {
  const { uploadId } = req.params;

  try {
    // quick validation
    const hasAny = await DraftCertificate.exists({ uploadId });
    if (!hasAny) {
      return res.status(404).json({ message: 'No drafts found for this uploadId' });
    }

    const willQueue = activeProcesses >= PROCESS_CONCURRENCY;
    const position = willQueue ? processQueue.length + 1 : 0;

    const p = enqueueProcess(uploadId);

    // already running or queued
    if (p && p.alreadyQueuedOrRunning) {
      return res.status(202).json({
        message: 'Already queued or running',
        uploadId,
        state: inFlight.has(uploadId) ? 'processing' : 'queued',
        concurrency: { active: activeProcesses, limit: PROCESS_CONCURRENCY, queueLength: processQueue.length }
      });
    }

    // fire-and-forget; client can poll GET /certificates/drafts/:uploadId
    if (p && typeof p.then === 'function') {
      p.then(() => { /* no-op */ }).catch((err) => console.error('Queue item failed:', err.message));
    }

    return res.status(202).json({
      message: willQueue ? `Queued at position ${position}` : 'Processing started',
      uploadId,
      state: willQueue ? 'queued' : 'processing',
      concurrency: { active: activeProcesses, limit: PROCESS_CONCURRENCY, queueLength: processQueue.length }
    });
  } catch (err) {
    console.error('❌ Queueing error:', err.message);
    return res.status(500).json({ error: 'Failed to enqueue processing' });
  }
};

exports.getDraftsByUploadId = async (req, res) => {
  const { uploadId } = req.params;

  try {
    const drafts = await DraftCertificate.find({ uploadId });

    if (drafts.length === 0) {
      return res.status(404).json({ message: 'No drafts found for this uploadId' });
    }

    // Csak fontos mezők visszaadása (ne adjuk vissza pl. OCR teljes szövegét)
    const response = drafts.map(draft => ({
      id: draft._id.toString(),
      fileName: draft.fileName,
      status: draft.status,
      docxPath: draft.docxPath,
      pdfPath: draft.originalPdfPath,
      blobPdfPath: draft.blobPdfPath || null,
      blobDocxPath: draft.blobDocxPath || null,
      fileUrl: draft.blobPdfPath || null,
      extractedData: draft.extractedData,
      error: draft.status === 'error' ? 'Feldolgozási hiba' : null
    }));

    res.json({ uploadId, drafts: response });
  } catch (err) {
    console.error('❌ Lekérés hiba:', err.message);
    res.status(500).json({ error: 'Nem sikerült lekérni a vázlatokat' });
  }
};

const Certificate = require('../models/certificate');

// Allowed keys we accept from the UI for inline edits
const ALLOWED_EXTRACTED_KEYS = new Set([
  'certNo','scheme','issueDate','applicant','protection','exmarking','equipment','manufacturer','xcondition','ucondition','specCondition','status','description','docType'
]);

function sanitizeOverrides(src = {}) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!ALLOWED_EXTRACTED_KEYS.has(k)) continue;
    // Coerce booleans for x/u condition
    if (k === 'xcondition' || k === 'ucondition') {
      out[k] = !!v;
    } else if (typeof v === 'string') {
      out[k] = v.trim();
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---- Duplicate handling helpers (visibility/tenant + certNo + issueDate) ----
function isDuplicateKeyError(err) {
  // MongoServerError duplicate
  return err && (err.code === 11000 || (err.name === 'MongoServerError' && err.message && err.message.includes('E11000')));
}

/**
 * Build a conflicts array by checking which (scope, certNo, issueDate) combos already exist.
 * Scope rules:
 *   - visibility === 'public'  -> unique by (visibility='public', certNo, issueDate)
 *   - visibility === 'private' -> unique by (tenantId, certNo, issueDate)
 * @param {Array<{visibility:'public'|'private', certNo:string, issueDate:string}>} items
 * @param {string|ObjectId} tenantId
 * @returns {Promise<Array<{visibility:'public'|'private', certNo:string, issueDate:string}>>}
 */
async function findCertificateConflicts(items = [], tenantId) {
  const unique = new Map();
  for (const it of items) {
    const v = (it.visibility || 'private').toLowerCase();
    const key = `${v}|${(it.certNo || '').trim()}|${(it.issueDate || '').trim()}`;
    if (!unique.has(key)) unique.set(key, { ...it, visibility: v });
  }

  const checks = Array.from(unique.values()).map(async it => {
    const v = (it.visibility || 'private').toLowerCase();
    const query = (v === 'public')
      ? { visibility: 'public', certNo: it.certNo, issueDate: it.issueDate }
      : { tenantId: tenantId, visibility: 'private', certNo: it.certNo, issueDate: it.issueDate };

    const exists = await Certificate.exists(query);
    return exists ? { visibility: v, certNo: it.certNo, issueDate: it.issueDate } : null;
  });

  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

/**
 * Send a standardized 409 response for duplicate certificate constraint.
 */
function sendDuplicateResponse(res, conflicts) {
  return res.status(409).json({
    error: 'DUPLICATE_CERTIFICATE',
    message: 'One or more certificates already exist with the same (visibility/tenant, certNo, issueDate).',
    conflicts
  });
}


// 🔹 Update a single draft's extracted fields BY ID (inline edit save)
exports.updateDraftExtractedById = async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  try {
    const draft = await DraftCertificate.findById(id);
    if (!draft) {
      return res.status(404).json({ message: '❌ Draft not found' });
    }
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ message: '❌ Missing tenantId' });
    }
    if (draft.tenantId && String(draft.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: '❌ Forbidden (wrong tenant)' });
    }

    const overrides = sanitizeOverrides(req.body?.extractedData || req.body || {});
    draft.extractedData = { ...(draft.extractedData || {}), ...overrides };
    await draft.save();

    return res.json({
      id: draft._id.toString(),
      fileName: draft.fileName,
      status: draft.status,
      docxPath: draft.docxPath,
      pdfPath: draft.originalPdfPath,
      extractedData: draft.extractedData,
    });
  } catch (err) {
    console.error('❌ Update draft by ID error:', err.message);
    return res.status(500).json({ error: 'Failed to update draft by ID' });
  }
};

exports.finalizeDrafts = async (req, res) => {
  const { uploadId } = req.params;
  const userId = req.userId;
  // SuperAdmin role parsing
  const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString();
  const isSuperAdmin = /superadmin/i.test(roleRaw);

  try {
    const tenantId = req.scope?.tenantId;
    if (!isSuperAdmin && !tenantId) {
      return res.status(403).json({ message: '❌ Missing tenantId' });
    }

    const draftsQuery = isSuperAdmin ? { uploadId, status: 'ready' } : { uploadId, status: 'ready', tenantId };
    const drafts = await DraftCertificate.find(draftsQuery);
    if (drafts.length === 0) {
      return res.status(404).json({ message: '❌ No ready drafts found for this uploadId' });
    }

    const overridesMap = (req.body && req.body.overrides) || {};
    const resultsSaved = [];            // IDs of drafts successfully finalized
    const conflicts = [];               // [{ company, certNo, issueDate }]
    const otherErrors = [];             // [{ id, error }]
    const cleanupItems = [];            // FS cleanup for saved docs only

    // Process each draft independently to allow partial success on duplicates
    for (const draft of drafts) {
      try {
        const data = draft.extractedData || {};
        const idKey = draft._id.toString();
        const bodyOverrides = overridesMap[idKey] || overridesMap[draft.fileName] || null;
        const merged = { ...data, ...sanitizeOverrides(bodyOverrides || {}) };

        // Véglegesítéskor: mozgatás a végleges helyre: certificates/<certNo>/<base>.(pdf|docx)
        const baseName = String((merged.certNo || draft.fileName || '')).replace(/\.pdf$/i, '').trim() || draft.fileName.replace(/\.pdf$/i, '');

        const srcPdf = draft.blobPdfPath || null;
        const srcDocx = draft.blobDocxPath || null;

        const uploadedPdf  = await moveBlobWithVersioning(srcPdf,  baseName, 'pdf');
        const uploadedDocx = await moveBlobWithVersioning(srcDocx, baseName, 'docx');

        const targetTenantId = isSuperAdmin ? draft.tenantId : tenantId;
        const doc = {
          tenantId: targetTenantId,
          visibility: (merged.scheme || '').toLowerCase() === 'atex' ? 'public' : 'private',
          certNo: merged.certNo || draft.fileName,
          scheme: merged.scheme || '',
          status: merged.status || '',
          issueDate: merged.issueDate || '',
          applicant: merged.applicant || '',
          protection: merged.protection || '',
          equipment: merged.equipment || '',
          manufacturer: merged.manufacturer || '',
          exmarking: merged.exmarking || '',
          xcondition: merged.xcondition || false,
          ucondition: merged.ucondition || false,
          specCondition: merged.specCondition || '',
          description: merged.description || '',
          docType: merged.docType || '',
          fileName: draft.fileName,
          fileUrl: uploadedPdf,
          docxUrl: uploadedDocx,

          // Keep original author from the draft
          createdBy: draft.createdBy,
          // Audit approver
          approvedBy: userId,
          approvedAt: new Date(),

          isDraft: false,
        };

        try {
          // Try create — catch duplicates and continue with others
          await Certificate.create(doc);
          resultsSaved.push(draft._id.toString());
          cleanupItems.push({
            pdfPath: draft.originalPdfPath,
            docxPath: draft.docxPath,
            uploadId: draft.uploadId
          });
        } catch (insErr) {
          if (isDuplicateKeyError(insErr)) {
            conflicts.push({ visibility: doc.visibility, certNo: doc.certNo, issueDate: doc.issueDate });
          } else {
            otherErrors.push({ id: draft._id.toString(), error: insErr.message || 'Insert error' });
          }
          // do not delete draft on failure — user can fix/retry
          continue;
        }
      } catch (innerErr) {
        otherErrors.push({ id: (draft && draft._id ? draft._id.toString() : 'n/a'), error: innerErr.message || 'Finalize error' });
        // continue with next draft
      }
    }

    // Delete only successfully finalized drafts; leave duplicates/failed in place
    if (resultsSaved.length > 0) {
      // Convert string IDs to ObjectIds to avoid any type mismatch
      const savedObjectIds = resultsSaved.map(id => new mongoose.Types.ObjectId(id));
      // Mark as finalized (so getPendingUploads won't include them even if deletion is delayed)
      await DraftCertificate.updateMany(
        { _id: { $in: savedObjectIds } },
        { $set: { status: 'finalized' } }
      );
      // Hard delete them
      await DraftCertificate.deleteMany({ _id: { $in: savedObjectIds } });
    }

    // Cleanup files only for saved ones
    for (const it of cleanupItems) {
      safeUnlink(it.pdfPath);
      safeUnlink(it.docxPath);
    }
    // If no more drafts under this upload, remove folder
    const remaining = await DraftCertificate.countDocuments({ uploadId });
    if (remaining === 0) {
      removeDraftFolderIfEmpty(uploadId);
    }

    // Build response
    const payload = {
      message: conflicts.length
        ? '✅ Partial success: some certificates saved, some duplicates detected.'
        : '✅ Certificates finalized successfully',
      savedCount: resultsSaved.length,
      removedIds: resultsSaved,
      conflicts,        // duplicates (not saved)
      otherErrors       // non-duplicate errors (not saved)
    };

    if (resultsSaved.length > 0 && conflicts.length === 0 && otherErrors.length === 0) {
      // full success
      return res.json(payload);
    }

    if (resultsSaved.length > 0 && (conflicts.length > 0 || otherErrors.length > 0)) {
      // partial success – return 200 with details so frontend can remove saved rows and still show hints
      payload.partial = true;
      return res.status(200).json(payload);
    }

    // nothing saved at all
    if (conflicts.length > 0 && resultsSaved.length === 0 && otherErrors.length === 0) {
      // pure duplicate case -> 409 to keep existing UX
      return sendDuplicateResponse(res, conflicts);
    }

    // other errors only (or mixed with duplicates but none saved)
    return res.status(500).json({
      error: 'FINALIZE_FAILED',
      message: 'No certificates could be saved.',
      conflicts,
      otherErrors
    });
  } catch (err) {
    console.error('❌ Finalization error:', err.message);
    return res.status(500).json({ error: 'Failed to finalize drafts' });
  }
};


exports.finalizeSingleDraftById = async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  // SuperAdmin role parsing
  const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString();
  const isSuperAdmin = /superadmin/i.test(roleRaw);

  try {
    const tenantId = req.scope?.tenantId;
    if (!isSuperAdmin && !tenantId) {
      return res.status(403).json({ message: '❌ Missing tenantId' });
    }

    const draft = await DraftCertificate.findById(id);
    if (!draft || draft.status !== 'ready') {
      return res.status(404).json({ message: '❌ Draft not found or not ready' });
    }
    if (!isSuperAdmin && draft.tenantId && String(draft.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: '❌ Forbidden (wrong tenant)' });
    }

    const data = draft.extractedData || {};
    const merged = { ...data, ...sanitizeOverrides(req.body?.overrides || req.body || {}) };

    // Véglegesítéskor: mozgatás a végleges helyre: certificates/<certNo>/<base>.(pdf|docx)
    const baseName = String((merged.certNo || draft.fileName || '')).replace(/\.pdf$/i, '').trim() || draft.fileName.replace(/\.pdf$/i, '');

    const srcPdf = draft.blobPdfPath || null;
    const srcDocx = draft.blobDocxPath || null;

    const uploadedPdf  = await moveBlobWithVersioning(srcPdf,  baseName, 'pdf');
    const uploadedDocx = await moveBlobWithVersioning(srcDocx, baseName, 'docx');

    const targetTenantId = isSuperAdmin ? draft.tenantId : tenantId;
    const doc = {
      tenantId: targetTenantId,
      visibility: (merged.scheme || '').toLowerCase() === 'atex' ? 'public' : 'private',
      certNo: merged.certNo || draft.fileName,
      scheme: merged.scheme || '',
      status: merged.status || '',
      issueDate: merged.issueDate || '',
      applicant: merged.applicant || '',
      protection: merged.protection || '',
      equipment: merged.equipment || '',
      manufacturer: merged.manufacturer || '',
      exmarking: merged.exmarking || '',
      xcondition: merged.xcondition || false,
      ucondition: merged.ucondition || false,
      specCondition: merged.specCondition || '',
      description: merged.description || '',
      docType: merged.docType || '',
      fileName: draft.fileName,
      fileUrl: uploadedPdf,
      docxUrl: uploadedDocx,

      // Keep original author from the draft
      createdBy: draft.createdBy,
      // Audit approver
      approvedBy: userId,
      approvedAt: new Date(),

      isDraft: false,
    };

    let session = null;
    try {
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        await Certificate.create([doc], { session });
        await DraftCertificate.deleteOne({ _id: id }, { session });
      });
      session.endSession();
    } catch (txErr) {
      if (session) session.endSession();
      if (isDuplicateKeyError(txErr)) {
        const conflicts = await findCertificateConflicts([{ visibility: doc.visibility, certNo: doc.certNo, issueDate: doc.issueDate }], tenantId);
        return sendDuplicateResponse(res, conflicts);
      }
      try {
        await Certificate.create(doc);
        await DraftCertificate.deleteOne({ _id: id });
      } catch (insErr) {
        if (isDuplicateKeyError(insErr)) {
          const conflicts = await findCertificateConflicts([{ visibility: doc.visibility, certNo: doc.certNo, issueDate: doc.issueDate }], tenantId);
          return sendDuplicateResponse(res, conflicts);
        }
        throw insErr;
      }
    }

    // FS cleanup after successful DB operations
    safeUnlink(draft.originalPdfPath);
    safeUnlink(draft.docxPath);
    const remaining = await DraftCertificate.countDocuments({ uploadId: draft.uploadId });
    if (remaining === 0) removeDraftFolderIfEmpty(draft.uploadId);

    return res.json({
      message: '✅ Certificate finalized',
      certificate: doc,
      removedId: id
    });
  } catch (err) {
    console.error('❌ Finalization by ID error:', err.message);
    return res.status(500).json({ error: 'Failed to finalize draft by ID' });
  }
};

// 🔹 Pending upload-ok listája (még NEM véglegesített feltöltések)
// Olyan uploadId-k, amelyekhez tartozik legalább egy 'draft' vagy 'ready' (esetleg 'error') státuszú draft.
exports.getPendingUploads = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString();
    const isSuperAdmin = /superadmin/i.test(roleRaw);

    if (!isSuperAdmin && !tenantId) {
      return res.status(403).json({ error: 'Missing tenantId' });
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;

    const matchTenantStage = isSuperAdmin
      ? { $match: { } } // no tenant filter for SuperAdmin
      : { $match: { tenantId: new mongoose.Types.ObjectId(tenantId) } };

    const pipeline = [
      matchTenantStage,
      {
        $match: {
          status: { $in: ['draft', 'ready', 'error'] }, // 'finalized' kikerül
        }
      },
      {
        $group: {
          _id: '$uploadId',
          uploadId: { $first: '$uploadId' },
          tenantId: { $first: '$tenantId' },
          createdAt: { $min: '$createdAt' },
          total: { $sum: 1 },
          ready: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
          draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
          error: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
          sampleFiles: { $push: '$fileName' }
        }
      },
      {
        $project: {
          _id: 0,
          uploadId: 1,
          tenantId: 1,
          createdAt: 1,
          counts: {
            total: '$total',
            ready: '$ready',
            draft: '$draft',
            error: '$error'
          },
          sampleFiles: { $slice: ['$sampleFiles', 5] } // max 5 fájlnév előnézet
        }
      },
      { $sort: { createdAt: -1 } }
    ];

    if (limit && Number.isFinite(limit)) {
      pipeline.push({ $limit: limit });
    }

    const items = await DraftCertificate.aggregate(pipeline);

    // Enrich with live queue state
    const enriched = (items || []).map(it => {
      let queueState = null;
      let queuePosition = null;

      if (inFlight.has(it.uploadId)) {
        queueState = 'processing';
      } else {
        const idx = processQueue.findIndex(x => x && x.uploadId === it.uploadId);
        if (idx !== -1) {
          queueState = 'queued';
          queuePosition = idx + 1;
        }
      }

      const c = it.counts || {};
      const ready = Number(c.ready || 0);
      const error = Number(c.error || 0);
      const total = Number(c.total || 0);
      const finished = total > 0 && ready + error === total;
      if (finished) {
        queueState = null;
        queuePosition = null;
      }

      return {
        ...it,
        queueState,
        queuePosition
      };
    });

    const concurrency = {
      active: activeProcesses,
      limit: PROCESS_CONCURRENCY,
      queueLength: processQueue.length
    };

    return res.json({ items: enriched, concurrency, scope: isSuperAdmin ? 'all-tenants' : 'tenant' });
  } catch (err) {
    console.error('❌ getPendingUploads error:', err.message);
    return res.status(500).json({ error: 'Failed to load pending uploads' });
  }
};

// -------------------------
// CANCEL / DELETE pending upload (ÚJ)
// -------------------------
exports.deletePendingUpload = async (req, res) => {
  const { uploadId } = req.params;
  const userId = req.userId;

  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });

    const drafts = await DraftCertificate.find({ uploadId, tenantId });
    if (!drafts.length) {
      return res.status(404).json({ message: 'No drafts found for this uploadId' });
    }

    // ideiglenes fájlok törlése
    for (const d of drafts) {
      safeUnlink(d.originalPdfPath);
      safeUnlink(d.docxPath);
      // 🔹 blob fájlok törlése
      try { if (d.blobPdfPath)  await azureBlobService.deleteFile(d.blobPdfPath); } catch(e){}
      try { if (d.blobDocxPath) await azureBlobService.deleteFile(d.blobDocxPath); } catch(e){}
    }

    // mappa törlése
    removeDraftFolderIfEmpty(uploadId);
    // draft rekordok törlése
    const del = await DraftCertificate.deleteMany({ uploadId, tenantId });

    return res.json({
      message: '✅ Pending upload deleted',
      uploadId,
      deletedDrafts: del.deletedCount || 0
    });
  } catch (err) {
    console.error('❌ deletePendingUpload error:', err.message);
    return res.status(500).json({ error: 'Failed to delete pending upload' });
  }
};

exports.getDraftPdfById = async (req, res) => {
  const { id } = req.params;
  try {
    const draft = await DraftCertificate.findById(id).lean();
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const tenantId = req.scope?.tenantId;
    if (!tenantId || (draft.tenantId && String(draft.tenantId) !== String(tenantId))) {
      return res.status(403).json({ error: 'Forbidden (wrong tenant)' });
    }
    if (draft.originalPdfPath && fs.existsSync(draft.originalPdfPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      const abs = path.resolve(draft.originalPdfPath);
      return res.sendFile(abs);
    }
    if (draft.blobPdfPath) {
      try {
        const sasUrl = await azureBlobService.getReadSasUrl(draft.blobPdfPath, { ttlSeconds: 600 });
        return res.redirect(302, sasUrl);
      } catch (e) {
        console.error('[getDraftPdfById] SAS generation error:', e.message);
      }
    }
    return res.status(404).json({ error: 'PDF file not found' });
  } catch (e) {
    console.error('[getDraftPdfById] error:', e.message);
    return res.status(500).json({ error: 'Failed to stream PDF' });
  }
};

// Return SAS URL (JSON) for a draft PDF by ID – suitable for front-end XHR (with Authorization)
exports.getDraftPdfSasById = async (req, res) => {
  const { id } = req.params;
  // SuperAdmin role parsing
  const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString();
  const isSuperAdmin = /superadmin/i.test(roleRaw);
  try {
    const draft = await DraftCertificate.findById(id).lean();
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const tenantId = req.scope?.tenantId;
    if (!isSuperAdmin && (!tenantId || (draft.tenantId && String(draft.tenantId) !== String(tenantId)))) {
      return res.status(403).json({ error: 'Forbidden (wrong tenant)' });
    }

    if (draft.blobPdfPath) {
      try {
        const sasUrl = await azureBlobService.getReadSasUrl(draft.blobPdfPath, { ttlSeconds: 600 });
        return res.json({ sasUrl, ttlSeconds: 600 });
      } catch (e) {
        console.error('[getDraftPdfSasById] SAS generation error:', e.message);
        return res.status(500).json({ error: 'Failed to generate SAS URL' });
      }
    }

    // Fallback: if there is only a local file, return a 409 to force the client to use the stream endpoint instead
    if (draft.originalPdfPath && fs.existsSync(draft.originalPdfPath)) {
      return res.status(409).json({ error: 'Only local file available; use stream endpoint', stream: true });
    }

    return res.status(404).json({ error: 'PDF file not found' });
  } catch (e) {
    console.error('[getDraftPdfSasById] error:', e.message);
    return res.status(500).json({ error: 'Failed to generate PDF SAS URL' });
  }
};

// Delete a single draft by its ID (and cleanup files/folder)
exports.deleteDraftById = async (req, res) => {
  const { id } = req.params;
  // SuperAdmin role parsing
  const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString();
  const isSuperAdmin = /superadmin/i.test(roleRaw);
  try {
    const draft = await DraftCertificate.findById(id);
    if (!draft) {
      return res.status(404).json({ message: '❌ Draft not found' });
    }
    const tenantId = req.scope?.tenantId;
    if (!isSuperAdmin && (!tenantId || (draft.tenantId && String(draft.tenantId) !== String(tenantId)))) {
      return res.status(403).json({ message: '❌ Forbidden (wrong tenant)' });
    }
    // ideiglenes fájlok törlése
    safeUnlink(draft.originalPdfPath);
    safeUnlink(draft.docxPath);
    // 🔹 blob fájlok törlése
    try { if (draft.blobPdfPath)  await azureBlobService.deleteFile(draft.blobPdfPath); } catch(e){}
    try { if (draft.blobDocxPath) await azureBlobService.deleteFile(draft.blobDocxPath); } catch(e){}

    // draft rekord törlés
    await DraftCertificate.deleteOne({ _id: id });

    // ha az upload alatt nincs több draft, mappa takarítás
    const remaining = await DraftCertificate.countDocuments({ uploadId: draft.uploadId });
    if (remaining === 0) {
      removeDraftFolderIfEmpty(draft.uploadId);
    }

    return res.json({
      message: '✅ Draft deleted',
      id,
      uploadId: draft.uploadId,
      remainingInUpload: remaining
    });
  } catch (err) {
    console.error('❌ deleteDraftById error:', err.message);
    return res.status(500).json({ error: 'Failed to delete draft' });
  }
};

// -------------------------
// COUNT my pending drafts (not finalized/deleted)
// -------------------------
// Returns total and per-status counts for the current tenant+user,
// considering only statuses that are still pending in the drafts collection.
exports.countMyPendingDrafts = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId;

    if (!tenantId || !userId) {
      return res.status(403).json({ error: 'Missing tenantId or userId' });
    }

    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
    // If your createdBy is stored as ObjectId, convert; else leave as string.
    const isObjId = /^[a-fA-F0-9]{24}$/.test(String(userId));
    const createdByValue = isObjId ? new mongoose.Types.ObjectId(String(userId)) : String(userId);

    // Only drafts that are still active/pending in the collection
    const PENDING_STATUSES = ['draft', 'ready', 'error'];

    const pipeline = [
      { $match: { tenantId: tenantObjectId, createdBy: createdByValue, status: { $in: PENDING_STATUSES } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    const rows = await DraftCertificate.aggregate(pipeline);

    const byStatus = { draft: 0, ready: 0, error: 0 };
    let total = 0;
    for (const r of rows) {
      const k = r?._id;
      const c = Number(r?.count || 0);
      if (k && typeof byStatus[k] !== 'undefined') {
        byStatus[k] = c;
        total += c;
      }
    }

    return res.json({
      total,
      byStatus
    });
  } catch (err) {
    console.error('❌ countMyPendingDrafts error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to count pending drafts' });
  }
};