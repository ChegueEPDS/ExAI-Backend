const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { generateDocxFile } = require('../helpers/docx');
const azureBlobService = require('../services/azureBlobService');
const Notification = require('../models/notification');
const bus = require('../lib/notifications/bus');

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
  console.log(`[enqueueProcess] request uploadId=${uploadId} inFlight=${Array.from(inFlight).join(',')} queued=${processQueue.map(x => x.uploadId).join(',')}`);
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
      // the authenticated user who owns this upload
      const createdBy = req.userId || null;
      console.log(`[bulkUpload] uploadId=${uploadId} createdBy=${createdBy}`);
      const targetDir = path.join('storage', 'certificates', 'draft', uploadId);

      fs.mkdirSync(targetDir, { recursive: true });

      // 🔹 2. Minden fájlt átmásolunk a draft mappába
      for (const file of req.files) {
        const targetPath = path.join(targetDir, file.originalname);
        fs.renameSync(file.path, targetPath); // áthelyezés uploads → draft mappa

        // 🔹 3. Mentés az ideiglenes DB-be
        await DraftCertificate.create({
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

    for (const draft of drafts) {
      try {
        const pdfBuffer = fs.readFileSync(draft.originalPdfPath);

        // 1) OCR
        const { recognizedText } = await uploadPdfWithFormRecognizerInternal(pdfBuffer);

        // 2) OpenAI kivonat
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
    }

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

    console.log('[notify-check] uploadId=%s userId=%s totals=%o finished=%s',
      uploadId, userId || 'n/a', { total, ready, draft, error }, finished);

    if (finished && userId) {
      const title = 'Bulk processing finished';
      const message = `Upload ${uploadId}: ${ready} ready, ${error} error.`;

      const notif = await Notification.create({
        userId: userId.toString(),
        type: 'task-complete',
        title,
        message,
        data: { uploadId, total, ready, error }
        // status alapból 'unread', readAt null – a sémában
      });

      bus.emitTo(userId.toString(), 'task-complete', {
        id: notif._id.toString(),
        type: 'task-complete',
        title,
        message,
        uploadId,
        total,
        ready,
        error,
        createdAt: notif.createdAt
      });

      console.log('[notify] persisted + emitted task-complete for uploadId=%s to user=%s', uploadId, userId.toString());
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


// 🔹 Update a single draft's extracted fields BY ID (inline edit save)
exports.updateDraftExtractedById = async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  try {
    const draft = await DraftCertificate.findById(id);
    if (!draft) {
      return res.status(404).json({ message: '❌ Draft not found' });
    }

    // Optional: ownership/company check (keep it lightweight; same as finalize uses)
    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ message: '❌ Invalid user' });
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
    console.log('🔍 Finalizing drafts for uploadId:', uploadId, 'userId:', userId);
    const user = await User.findById(userId);
    if (!user || !user.company) {
      return res.status(400).json({ message: '❌ Invalid user or missing company' });
    }

    console.log('ℹ️ Skipping access token / Entra ID checks (no OneDrive/SharePoint).');

    const drafts = await DraftCertificate.find({ uploadId, status: 'ready' });
    if (drafts.length === 0) {
      return res.status(404).json({ message: '❌ No ready drafts found for this uploadId' });
    }

    const certificates = [];
    const draftIds = [];
    const overridesMap = (req.body && req.body.overrides) || {};
    const cleanupItems = []; // { pdfPath, docxPath, uploadId }

    // 1) Fájlok feltöltése és dokumentumok előkészítése
    for (const draft of drafts) {
      draftIds.push(draft._id);
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

      certificates.push({
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
        company: user.company,
        isDraft: false,
      });

      cleanupItems.push({
        pdfPath: draft.originalPdfPath,
        docxPath: draft.docxPath,
        uploadId: draft.uploadId
      });
    }

    // 2) Insert + Delete tranzakcióban (ha lehet)
    let session = null;
    try {
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        await Certificate.insertMany(certificates, { session });
        await DraftCertificate.deleteMany({ _id: { $in: draftIds } }, { session });
      });
      session.endSession();
    } catch (txErr) {
      if (session) session.endSession();
      // Fallback: tranzakció nélkül
      await Certificate.insertMany(certificates);
      await DraftCertificate.deleteMany({ _id: { $in: draftIds } });
    }

    // 3) Lokális fájlok törlése + mappa takarítás
    for (const it of cleanupItems) {
      safeUnlink(it.pdfPath);
      safeUnlink(it.docxPath);
    }
    const remaining = await DraftCertificate.countDocuments({ uploadId });
    if (remaining === 0) {
      removeDraftFolderIfEmpty(uploadId);
    }

    return res.json({
      message: '✅ Certificates finalized successfully',
      count: certificates.length,
      removedIds: draftIds.map(x => x.toString())
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
    console.log('🔍 Finalizing single draft by ID:', { id, userId });
    const user = await User.findById(userId);
    if (!user || !user.company) {
      return res.status(400).json({ message: '❌ Invalid user or missing company' });
    }

    const draft = await DraftCertificate.findById(id);
    if (!draft || draft.status !== 'ready') {
      return res.status(404).json({ message: '❌ Draft not found or not ready' });
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
      company: user.company,
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
      await Certificate.create(doc);
      await DraftCertificate.deleteOne({ _id: id });
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
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;

    const pipeline = [
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
    console.log('[getPendingUploads] aggregated uploadIds=', (items || []).map(it => it.uploadId));
    console.log('[getPendingUploads] inFlight=', Array.from(inFlight));
    console.log('[getPendingUploads] queue=', processQueue.map(x => x.uploadId));
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
    console.log('[getPendingUploads] enriched states=', enriched.map(e => ({
      uploadId: e.uploadId,
      state: e.queueState,
      pos: e.queuePosition,
      finished: ((e.counts?.ready||0)+(e.counts?.error||0)) === (e.counts?.total||0)
    })));


    // Optionally expose overall concurrency snapshot for UI (useful for diagnostics)
    const concurrency = {
      active: activeProcesses,
      limit: PROCESS_CONCURRENCY,
      queueLength: processQueue.length
    };
    console.log('[getPendingUploads] concurrency snapshot=', { active: activeProcesses, limit: PROCESS_CONCURRENCY, queueLength: processQueue.length });
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
    // opcionális: tulajdonjog vizsgálat
    // const user = await User.findById(userId);
    // if (!user) return res.status(400).json({ message: '❌ Invalid user' });

    const drafts = await DraftCertificate.find({ uploadId });
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
    const del = await DraftCertificate.deleteMany({ uploadId });

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