const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { generateDocxFile } = require('../helpers/docx');
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
      const targetDir = path.join('storage', 'certificates', 'draft', uploadId);

      fs.mkdirSync(targetDir, { recursive: true });

      // 🔹 2. Minden fájlt átmásolunk a draft mappába
      for (const file of req.files) {
        const targetPath = path.join(targetDir, file.originalname);
        fs.renameSync(file.path, targetPath); // áthelyezés uploads → draft mappa

        // 🔹 3. Mentés az ideiglenes DB-be
        await DraftCertificate.create({
          tenantId,
          uploadId,
          fileName: file.originalname,
          originalPdfPath: targetPath,
          status: 'draft',
          createdBy,
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
        const pdfBuffer = fs.readFileSync(draft.originalPdfPath);

        // 1) OCR
        const { recognizedText } = await uploadPdfWithFormRecognizerInternal(pdfBuffer);

        // 2) OpenAI kivonat (backoff + hosszabb timeout a helperben)
        const extractedData = await extractCertFieldsFromOCR(recognizedText);

        // 3) DOCX
        const originalFileName = draft.fileName.replace(/\.pdf$/i, '');
        const docxFileName = `${originalFileName}.docx`;
        const docxFullPath = path.join(path.dirname(draft.originalPdfPath), docxFileName);
        await generateDocxFile(recognizedText, originalFileName, extractedData?.scheme || 'ATEX', docxFullPath);

        // 4) Mentés
        draft.recognizedText = recognizedText;
        draft.extractedData = extractedData;
        draft.docxPath = docxFullPath;
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
  'certNo','scheme','issueDate','applicant','protection','exmarking','equipment','manufacturer','xcondition','ucondition','specCondition','status','description'
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

  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ message: '❌ Missing tenantId' });
    }

    const drafts = await DraftCertificate.find({ uploadId, status: 'ready', tenantId });
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

        const pdfFileName = draft.fileName;
        const docxFileName = path.basename(draft.docxPath || `${draft.fileName}.docx`);
        const blobFolder = `certificates/${merged.certNo || draft.fileName}`;

        let uploadedPdf = null;
        if (fs.existsSync(draft.originalPdfPath)) {
          try {
            await azureBlobService.uploadFile(draft.originalPdfPath, `${blobFolder}/${pdfFileName}`);
            uploadedPdf = `${blobFolder}/${pdfFileName}`;
          } catch (err) {
            console.warn(`⚠️ Blob PDF upload failed for ${pdfFileName}:`, err.message);
          }
        }

        let uploadedDocx = null;
        if (draft.docxPath && fs.existsSync(draft.docxPath)) {
          try {
            await azureBlobService.uploadFile(draft.docxPath, `${blobFolder}/${docxFileName}`);
            uploadedDocx = `${blobFolder}/${docxFileName}`;
          } catch (err) {
            console.warn(`⚠️ Blob DOCX upload failed for ${docxFileName}:`, err.message);
          }
        }

        const doc = {
          tenantId,
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
          fileName: draft.fileName,
          fileUrl: uploadedPdf,
          docxUrl: uploadedDocx,
          createdBy: userId,
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

  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ message: '❌ Missing tenantId' });
    }

    const draft = await DraftCertificate.findById(id);
    if (!draft || draft.status !== 'ready') {
      return res.status(404).json({ message: '❌ Draft not found or not ready' });
    }
    if (draft.tenantId && String(draft.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: '❌ Forbidden (wrong tenant)' });
    }

    const data = draft.extractedData || {};
    const merged = { ...data, ...sanitizeOverrides(req.body?.overrides || req.body || {}) };

    const pdfFileName = draft.fileName;
    const docxFileName = path.basename(draft.docxPath || `${draft.fileName}.docx`);
    const blobFolder = `certificates/${merged.certNo || draft.fileName}`;

    let uploadedPdf = null;
    if (fs.existsSync(draft.originalPdfPath)) {
      try {
        await azureBlobService.uploadFile(draft.originalPdfPath, `${blobFolder}/${pdfFileName}`);
        uploadedPdf = `${blobFolder}/${pdfFileName}`;
      } catch (err) {
        console.warn(`⚠️ Blob PDF upload failed for ${pdfFileName}:`, err.message);
      }
    }

    let uploadedDocx = null;
    if (draft.docxPath && fs.existsSync(draft.docxPath)) {
      try {
        await azureBlobService.uploadFile(draft.docxPath, `${blobFolder}/${docxFileName}`);
        uploadedDocx = `${blobFolder}/${docxFileName}`;
      } catch (err) {
        console.warn(`⚠️ Blob DOCX upload failed for ${docxFileName}:`, err.message);
      }
    }

    const doc = {
      tenantId,
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
      fileName: draft.fileName,
      fileUrl: uploadedPdf,
      docxUrl: uploadedDocx,
      createdBy: userId,
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
    if (!tenantId) {
      return res.status(403).json({ error: 'Missing tenantId' });
    }
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;

    const pipeline = [
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId) } },
      {
        $match: {
          status: { $in: ['draft', 'ready', 'error'] }, // 'finalized' kikerül
        }
      },
      {
        $group: {
          _id: '$uploadId',
          uploadId: { $first: '$uploadId' },
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
    // 🔹 Enrich with queue state (queued / processing) based on in-memory queue
    // NOTE: this reflects *current* process state; not persisted in DB.
    const enriched = (items || []).map(it => {
      let queueState = null;
      let queuePosition = null;

      // Determine live queue state first
      if (inFlight.has(it.uploadId)) {
        queueState = 'processing';
      } else {
        const idx = processQueue.findIndex(x => x && x.uploadId === it.uploadId);
        if (idx !== -1) {
          queueState = 'queued';
          queuePosition = idx + 1; // 1-based position
        }
      }

      // If this upload is already fully processed (ready+error == total),
      // then do NOT show it as processing/queued anymore
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


    // Optionally expose overall concurrency snapshot for UI (useful for diagnostics)
    const concurrency = {
      active: activeProcesses,
      limit: PROCESS_CONCURRENCY,
      queueLength: processQueue.length
    };
    return res.json({ items: enriched, concurrency });
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
    if (!draft.originalPdfPath || !fs.existsSync(draft.originalPdfPath)) {
      return res.status(404).json({ error: 'PDF file not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    const abs = path.resolve(draft.originalPdfPath);
    return res.sendFile(abs);
  } catch (e) {
    console.error('[getDraftPdfById] error:', e.message);
    return res.status(500).json({ error: 'Failed to stream PDF' });
  }
};

// Delete a single draft by its ID (and cleanup files/folder)
exports.deleteDraftById = async (req, res) => {
  const { id } = req.params;
  try {
    const draft = await DraftCertificate.findById(id);
    if (!draft) {
      return res.status(404).json({ message: '❌ Draft not found' });
    }
    const tenantId = req.scope?.tenantId;
    if (!tenantId || (draft.tenantId && String(draft.tenantId) !== String(tenantId))) {
      return res.status(403).json({ message: '❌ Forbidden (wrong tenant)' });
    }
    // ideiglenes fájlok törlése
    safeUnlink(draft.originalPdfPath);
    safeUnlink(draft.docxPath);

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