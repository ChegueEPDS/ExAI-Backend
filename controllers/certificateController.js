// controllers/certificateController.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Certificate = require('../models/certificate');
const CompanyCertificateLink = require('../models/companyCertificateLink');
const User = require('../models/user'); // 🔹 Importáljuk a User modellt
const multer = require('multer');
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása
const azureBlobService = require('../services/azureBlobService');
const { getReadSasUrl, toBlobPath } = azureBlobService;
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { extractCertFieldsFromOCR } = require('../helpers/openaiCertExtractor');
const mongoose = require('mongoose');
const {
  buildCertificateCacheForTenant,
  resolveCertificateFromCache
} = require('../helpers/certificateMatchHelper');
const contributionRewardService = require('../services/contributionRewardService');
const CertificatePreviewJob = require('../models/certificatePreviewJob');

const upload = multer({ dest: 'uploads/' });

const today = new Date();

// Helper to ensure link between tenant and certificate (adoption)
async function ensureLinkForTenant(tenantId, certId, userId, session) {
  if (!tenantId || !certId) return;
  await CompanyCertificateLink.updateOne(
    { tenantId, certId },
    { $setOnInsert: { tenantId, certId, addedBy: userId, addedAt: new Date() } },
    { upsert: true, session }
  );
}

// Detect if MongoDB supports multi-document transactions (replica set member or mongos)
async function supportsTransactions() {
  try {
    const admin = mongoose.connection.db.admin();
    let info;
    try {
      info = await admin.command({ hello: 1 }); // modern servers
    } catch {
      info = await admin.command({ isMaster: 1 }); // older servers
    }
    const isReplicaSet = !!info.setName;               // present on replica set members
    const isMongos = info.msg === 'isdbgrid';          // mongos routers
    const hasSessions = typeof info.logicalSessionTimeoutMinutes === 'number';
    return hasSessions && (isReplicaSet || isMongos);
  } catch {
    return false;
  }
}

// Whitelist for sorting to avoid collection scans on non-indexed fields
const ALLOWED_SORT_KEYS = new Set([
  'certNo', 'manufacturer', 'equipment', 'issueDate', 'createdAt', 'scheme', 'docType'
]);

// Base projection that matches the table needs
const BASE_PROJECT = {
  certNo: 1, scheme: 1, status: 1, issueDate: 1, applicant: 1,
  protection: 1, equipment: 1, manufacturer: 1, exmarking: 1,
  fileName: 1, fileUrl: 1, docxUrl: 1, uploadedAt: '$createdAt',
  xcondition: 1, specCondition: 1, description: 1, visibility: 1, docType: 1,
  adoptedByMe: 1
};

/**
 * Build a $project based on optional "fields" query parameter.
 * If fields is missing, use BASE_PROJECT. If present, allow a subset
 * like "certNo,manufacturer,equipment,issueDate".
 */
function buildProjectFromFields(fieldsParam) {
  if (!fieldsParam) return { ...BASE_PROJECT };
  const out = {};
  const list = String(fieldsParam)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  // Always keep minimal identifiers we rely on
  out._id = 1;
  for (const f of list) {
    if (f === 'uploadedAt') {
      // support alias
      out.uploadedAt = '$createdAt';
    } else if (Object.prototype.hasOwnProperty.call(BASE_PROJECT, f)) {
      out[f] = BASE_PROJECT[f];
    }
  }
  // If nothing valid was requested, fall back to BASE_PROJECT
  if (Object.keys(out).length <= 1) return { ...BASE_PROJECT };
  return out;
}

// ==== Index helpers for safe hinting ====
async function listIndexes(collectionName) {
  const col = mongoose.connection.db.collection(collectionName);
  const idx = await col.indexes();
  return idx; // [{ name, key: { a:1, b:-1 }, ...}, ...]
}

function sameKeySpec(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    if (!(k in b)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

async function hasExactIndex(collectionName, keySpec) {
  try {
    const idx = await listIndexes(collectionName);
    return idx.some(i => sameKeySpec(i.key || {}, keySpec));
  } catch {
    return false;
  }
}

// Map requested sort key -> exact compound index spec created in the model
const SORT_HINTS = Object.freeze({
  certNo:       { visibility: 1, certNo: 1, _id: 1 },
  manufacturer: { visibility: 1, manufacturer: 1, _id: 1 },
  equipment:    { visibility: 1, equipment: 1, _id: 1 },
  issueDate:    { visibility: 1, issueDate: -1, _id: 1 }, // index built descending on date
  createdAt:    { visibility: 1, createdAt: -1, _id: 1 }  // index built descending on createdAt
});

// Safely handle incoming id parameters (skip CastError)
function tryObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
}

// Small helper to escape user-provided filter strings in regex
function escapeRegex(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLooseCertNoRegex(value = '') {
  const source = (value || '').toString().trim();
  if (!source) return null;
  const pattern = source
    .split('')
    .map(ch => escapeRegex(ch))
    .join('\\s*');
  return new RegExp('^' + pattern, 'i');
}

// --- Helper: standardized duplicate (unique index) error response ---
function sendDuplicateError(res, err) {
  // MongoServerError E11000 handler
  const isDup =
    err?.code === 11000 ||
    err?.name === 'MongoServerError' && /E11000/i.test(err?.message || '');
  if (!isDup) return false;

  // Try to extract key/values if available
  const keyValue = err.keyValue || {};
  const details = {
    tenant: keyValue.tenantId,
    certNo: keyValue.certNo,
    issueDate: keyValue.issueDate
  };
  // Prefer 409 Conflict for duplicates
  res.status(409).json({
    error: 'DUPLICATE_CERTIFICATE',
    message: 'Már létezik tanúsítvány ezzel a (tenant, certNo, issueDate) kombinációval.',
    details
  });
  return true;
}

function safeBlobSegment(value, fallback = 'file') {
  return String(value || fallback)
    .trim()
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || fallback;
}

function normalizePreviewExtracted(aiData = {}) {
  const certStr = (aiData?.certNo || aiData?.certificateNumber || '').toString().trim().toUpperCase();
  return {
    certNo: aiData?.certNo || aiData?.certificateNumber || '',
    status: aiData?.status || '',
    issueDate: aiData?.issueDate || '',
    applicant: aiData?.applicant || '',
    manufacturer: aiData?.manufacturer || '',
    equipment: aiData?.equipment || aiData?.product || '',
    product: aiData?.product || aiData?.equipment || '',
    exmarking: aiData?.exmarking || aiData?.exMarking || '',
    protection: aiData?.protection || '',
    specCondition: aiData?.specCondition || aiData?.specialConditions || '',
    description: aiData?.description || '',
    docType: aiData?.docType || '',
    xcondition: certStr ? (certStr.endsWith('X') || /\bX\b/.test(certStr)) : false,
    ucondition: certStr ? (certStr.endsWith('U') || /\bU\b/.test(certStr)) : false
  };
}

async function runCertificatePreviewFromSource({ source, tenantId, fileName, updateJob }) {
  console.info(JSON.stringify({
    level: 'info',
    message: '[certificate preview] OCR start',
    tenantId: String(tenantId || ''),
    fileName
  }));

  const ocrStart = Date.now();
  const { recognizedText } = await uploadPdfWithFormRecognizerInternal(source);
  console.info(JSON.stringify({
    level: 'info',
    message: '[certificate preview] OCR done',
    elapsedMs: Date.now() - ocrStart,
    textLength: recognizedText?.length || 0
  }));

  if (typeof updateJob === 'function') {
    await updateJob({ recognizedText: recognizedText || '' });
  }

  console.info(JSON.stringify({ level: 'info', message: '[certificate preview] OpenAI extraction start' }));
  const aiData = await extractCertFieldsFromOCR(recognizedText || '', { tenantId: tenantId ? String(tenantId) : null });
  const extracted = normalizePreviewExtracted(aiData);
  console.info(JSON.stringify({ level: 'info', message: '[certificate preview] extraction done', extracted }));

  return { recognizedText: recognizedText || '', extracted };
}

async function processCertificatePreviewJob(jobId) {
  const job = await CertificatePreviewJob.findById(jobId);
  if (!job) return;
  if (!['created', 'queued', 'error'].includes(job.status)) return;

  await CertificatePreviewJob.updateOne(
    { _id: job._id },
    { $set: { status: 'processing', startedAt: new Date(), error: '' } }
  );

  try {
    const sasUrl = await azureBlobService.getReadSasUrl(job.blobPath, {
      ttlSeconds: 900,
      contentType: job.contentType || 'application/pdf'
    });
    const result = await runCertificatePreviewFromSource({
      source: { sourceUrl: sasUrl },
      tenantId: job.tenantId,
      fileName: job.fileName,
      updateJob: async (patch) => {
        await CertificatePreviewJob.updateOne({ _id: job._id }, { $set: patch });
      }
    });

    await CertificatePreviewJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'done',
          recognizedText: result.recognizedText,
          extracted: result.extracted,
          finishedAt: new Date()
        }
      }
    );
  } catch (err) {
    await CertificatePreviewJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'error',
          error: err?.message || 'Preview processing failed',
          finishedAt: new Date()
        }
      }
    );
  }
}

// Fájl feltöltési endpoint
exports.uploadCertificate = async (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(500).send('❌ Fájl feltöltési hiba.');

    // Guard: check if file was provided
    if (!req.file) {
      return res.status(400).json({ message: '❌ Hiányzó fájl a kérésben.' });
    }

    try {
      const {
        certNo,
        scheme,
        status,
        issueDate,
        applicant,
        protection,
        equipment,
        manufacturer,
        exmarking,
        xcondition,
        specCondition,
        description,
        ucondition,
        recognizedText
      } = req.body;
      const visibility = (req.body.visibility || '').toString().toLowerCase();
      const isPublicFlag = req.body.isPublic === true || req.body.isPublic === 'true';

      if (!certNo) {
        return res.status(400).json({ message: '❌ certNo kötelező!' });
      }
      // Tenant-alapú szkóp az authMiddleware-ből
      const tenantId = req.scope?.tenantId;
      const ownerUserId = req.scope?.userId || req.user?.id;
      if (!tenantId || !ownerUserId) {
        return res.status(403).json({ message: '❌ Hiányzó tenantId vagy user azonosító az authból' });
      }

      // --- REPLACE PDF/DOCX GENERATION & AZURE UPLOAD BLOCK ---
      const pdfPath = path.resolve(req.file.path);
      const originalPdfName = req.file.originalname;

      // Sanitize folder/file parts derived from certNo to avoid illegal blob names
      const safeCert = String(certNo).replace(/[^\w\-.]+/g, '_');
      const pdfFileName = originalPdfName || `${safeCert}.pdf`;

      // DOCX generálás (a meglévő helperrel – explicit cél útvonallal)
      const extractedText = recognizedText || 'Nincs OCR szöveg';
      const docxFileName = `${safeCert}_extracted.docx`;
      const docxTempPath = path.join('uploads', docxFileName);
      try {
        // generateDocxFile(recognizedText, originalFileName, scheme, outputPath)
        await generateDocxFile(extractedText, safeCert, scheme || 'ATEX', docxTempPath);
      } catch (e) {
        console.warn('⚠️ DOCX generálás sikertelen, üres DOCX létrehozása helyett kihagyjuk:', e.message);
      }

      // ===== Azure Blob Storage feltöltés =====
      const blobFolder = `certificates/${safeCert}`;

      let uploadedPdfPath = null;
      let uploadedDocxPath = null;

      try {
        await azureBlobService.uploadFile(pdfPath, `${blobFolder}/${pdfFileName}`);
        uploadedPdfPath = `${blobFolder}/${pdfFileName}`;
      } catch (e) {
        console.warn('⚠️ Blob PDF upload failed:', e.message);
      }

      try {
        if (fs.existsSync(docxTempPath)) {
          await azureBlobService.uploadFile(docxTempPath, `${blobFolder}/${docxFileName}`);
          uploadedDocxPath = `${blobFolder}/${docxFileName}`;
        }
      } catch (e) {
        console.warn('⚠️ Blob DOCX upload failed:', e.message);
      }
      // --- END REPLACEMENT BLOCK ---

      // ===== Mentés MongoDB-be =====
      const finalVisibility = (visibility === 'public' || isPublicFlag) ? 'public' : 'private';

      const certificate = new Certificate({
        // PRIVATE esetben marad a tenant alatti tulajdon
        // PUBLIC esetben először még mentjük tenantId-vel (pre-save miatt), aztán azonnal nullázzuk
        tenantId,
        certNo,
        scheme,
        status,
        issueDate,
        applicant,
        protection,
        equipment,
        manufacturer,
        exmarking,
        xcondition: xcondition === 'true' || xcondition === true,
        specCondition: specCondition || null,
        description,
        docType: typeof req.body.docType === 'string' ? req.body.docType.trim() : (req.body.docType || null),
        ucondition: ucondition === 'true' || ucondition === true,
        fileName: originalPdfName,
        fileUrl: uploadedPdfPath,
        docxUrl: uploadedDocxPath,
        createdBy: ownerUserId,
        visibility: finalVisibility,
        isDraft: false
      });

      try {
        await certificate.save();

        if (finalVisibility === 'public') {
          // 1) tenantId kivezetése (NULL) – updateOne, hogy ne fusson pre('save')
          await Certificate.updateOne(
            { _id: certificate._id },
            { $unset: { tenantId: "" } }
          );

          // 2) saját tenant link létrehozása, hogy a saját listában megmaradjon (adoptáltként)
          await ensureLinkForTenant(tenantId, certificate._id, ownerUserId);
        }

      } catch (e) {
        // If duplicate, return a clean 409 that the frontend can display
        if (sendDuplicateError(res, e)) {
          // Optional: try to clean uploaded blobs when DB save fails with duplicate
          try { if (uploadedPdfPath && typeof azureBlobService.deleteFile === 'function') await azureBlobService.deleteFile(uploadedPdfPath); } catch {}
          try { if (uploadedDocxPath && typeof azureBlobService.deleteFile === 'function') await azureBlobService.deleteFile(uploadedDocxPath); } catch {}
          // Also cleanup local temp files
          try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
          try { if (fs.existsSync(docxTempPath)) fs.unlinkSync(docxTempPath); } catch {}
          return;
        }
        throw e;
      }

      // Helyi ideiglenes fájlok törlése
      try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
      try { if (fs.existsSync(docxTempPath)) fs.unlinkSync(docxTempPath); } catch {}

      // Fire-and-forget reward check (do not block upload response)
      contributionRewardService
        .onCertificatesAdded({ userId: ownerUserId, added: 1 })
        .catch(() => {});

      return res.json({
        message: '✅ Feltöltés sikeres! (Azure Blob)',
        blob: { pdfPath: uploadedPdfPath, docxPath: uploadedDocxPath },
        data: certificate
      });
    } catch (error) {
      // If duplicate error, send standardized 409
      if (sendDuplicateError(res, error)) return;
      console.error('❌ Hiba a feltöltés során:', error.response?.data || error.message);
      return res.status(500).send('❌ Hiba a feltöltés során');
    }
  });
};

// Build a short-lived read SAS URL for an existing blob path
// Body: { fileUrl, contentType? }
// Returns: { sasUrl }
exports.getCertificateSas = async (req, res) => {
  try {
    const { fileUrl, contentType } = req.body || {};
    const blobPath = (typeof toBlobPath === 'function') ? toBlobPath(fileUrl) : (fileUrl || '');
    if (!blobPath || typeof blobPath !== 'string') {
      return res.status(400).json({ error: 'Invalid file.' });
    }

    if (typeof getReadSasUrl !== 'function') {
      console.error('[cert] getCertificateSas error: getReadSasUrl not available');
      return res.status(500).json({ error: 'SAS service not available' });
    }

    const sas = await getReadSasUrl(blobPath, {
      ttlSeconds: 300,
      contentType: contentType || 'application/pdf'
    });
    return res.json({ sasUrl: sas });
  } catch (e) {
    console.error('[cert] getCertificateSas error', e);
    return res.status(500).json({ error: 'Failed to build SAS URL' });
  }
};

// Tanúsítványok lekérdezése – SAJÁT tenant + adoptált PUBLIC-ok
exports.getCertificates = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ message: '❌ Hiányzó tenantId az authból!' });
    }

    console.log(`🔍 Saját (tenant=${tenantId}) + adoptált PUBLIC lekérés`);

    // Saját tenant összes tanúsítványa (független a visibility-től)
    const own = await Certificate.find({ tenantId }).lean();

    // Adoptáltak: csak PUBLIC cert-ek adoptálhatók/láthatók
    const links = await CompanyCertificateLink.find({ tenantId }).select('certId').lean();
    const adoptedIds = links.map(l => l.certId);

    let adoptedPublic = [];
    if (adoptedIds.length) {
      adoptedPublic = await Certificate.find({ _id: { $in: adoptedIds }, visibility: 'public' }).lean();
      adoptedPublic = adoptedPublic.map(c => ({ ...c, adoptedByMe: true }));
    }

    res.json([...own, ...adoptedPublic]);
  } catch (error) {
    console.error('❌ Hiba a lekérdezés során:', error);
    res.status(500).send('❌ Hiba a lekérdezés során');
  }
};

// Tanúsítványok lekérdezése – CSAK PUBLIC, adoptedByMe jelzéssel
exports.getPublicCertificates = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból!' });

    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);

    const certificates = await Certificate.aggregate([
      { $match: { visibility: 'public' } },
      {
        $lookup: {
          from: 'companycertificatelinks',
          let: { certId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$certId', '$$certId'] },
                    { $eq: ['$tenantId', tenantObjectId] }
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: 'myLink'
        }
      },
      { $addFields: { adoptedByMe: { $gt: [{ $size: '$myLink' }, 0] } } },
      { $project: { myLink: 0 } }
    ]);
    res.json(certificates);
  } catch (error) {
    console.error('❌ Hiba a public lekérdezés során:', error);
    res.status(500).send('❌ Hiba a public lekérdezés során');
  }
};

// PUBLIC (global) certificates – paginated + with adoptedByMe flag
// GET /api/certificates/public/paged?page=1&pageSize=25&sort=certNo&dir=asc&certNo=...&manufacturer=...&equipment=...
exports.getPublicCertificatesPaged = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId || null; // for adoptedByMe
    const tenantObjectId = tenantId ? new mongoose.Types.ObjectId(tenantId) : null;

    const page     = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);

    const sortKey  = (req.query.sort || 'certNo').toString();
    const dir      = (req.query.dir || 'asc').toString().toLowerCase() === 'desc' ? -1 : 1;
    const key = ALLOWED_SORT_KEYS.has(sortKey) ? sortKey : 'certNo';
    const sort = { [key]: dir, _id: 1 };

    const f = {
      certNo:       (req.query.certNo || '').trim(),
      manufacturer: (req.query.manufacturer || '').trim(),
      equipment:    (req.query.equipment || '').trim(),
    };

    const match = { visibility: 'public' };
    const certRegex = buildLooseCertNoRegex(f.certNo);
    if (certRegex) match.certNo = certRegex;
    if (f.manufacturer) match.manufacturer = { $regex: '^' + escapeRegex(f.manufacturer), $options: 'i' };
    if (f.equipment)    match.equipment    = { $regex: '^' + escapeRegex(f.equipment), $options: 'i' };

    const project = buildProjectFromFields(req.query.fields);

    // --- NEW: prefetch adopted ids for this tenant (no large lookup in pipeline) ---
    let adoptedIds = [];
    if (tenantObjectId) {
      const links = await CompanyCertificateLink
        .find({ tenantId: tenantObjectId })
        .select('certId')
        .lean();
      adoptedIds = links.map(l => l.certId);
    }

    // Aggregate with pagination first; then compute adoptedByMe on the N page items.
    const pipeline = [
      { $match: match },
      { $sort: sort },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
            // adoptedByMe computed without $lookup
            ...(tenantObjectId
              ? [{ $addFields: { adoptedByMe: { $in: ['$_id', adoptedIds] } } }]
              : [{ $addFields: { adoptedByMe: false } }]),
            { $project: project }
          ],
          total: [{ $count: 'count' }]
        }
      }
    ];

    // Create aggregate cursor with disk spill enabled for big sorts if needed
    let aggCursor = Certificate.aggregate(pipeline).allowDiskUse(true);

    // Apply an index hint only if the exact compound index exists (prevents runtime "hint not found")
    const hintSpec = SORT_HINTS[key] || SORT_HINTS.certNo;
    if (await hasExactIndex('certificates', hintSpec)) {
      aggCursor = aggCursor.hint(hintSpec);
    }

    const [agg] = await aggCursor.exec();
    const items = agg?.items || [];
    const total = agg?.total?.[0]?.count || 0;

    return res.json({ items, total, page, pageSize });
  } catch (e) {
    console.error('getPublicCertificatesPaged error:', e);
    return res.status(500).json({ error: 'Failed to load paged public certificates' });
  }
};

// Own tenant + adopted PUBLIC – paginated
// GET /api/certificates/paged?page=1&pageSize=25&sort=certNo&dir=asc&certNo=...&manufacturer=...&equipment=...
exports.getMyCertificatesPaged = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(400).json({ message: 'Missing tenantId' });
    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);

    const page     = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);

    const sortKey  = (req.query.sort || 'certNo').toString();
    const dir      = (req.query.dir || 'asc').toString().toLowerCase() === 'desc' ? -1 : 1;
    const key = ALLOWED_SORT_KEYS.has(sortKey) ? sortKey : 'certNo';
    const sort = { [key]: dir, _id: 1 };

    const f = {
      certNo:       (req.query.certNo || '').trim(),
      manufacturer: (req.query.manufacturer || '').trim(),
      equipment:    (req.query.equipment || '').trim(),
    };

    const ownIds = await Certificate.find({ tenantId: tenantObjectId }).select('_id').lean();
    const links  = await CompanyCertificateLink.find({ tenantId: tenantObjectId }).select('certId').lean();
    const adoptedIds = links.map(l => l.certId);

    const allIds = [...ownIds.map(x => x._id), ...adoptedIds];
    if (allIds.length === 0) {
      return res.json({ items: [], total: 0, page, pageSize });
    }

    const match = { _id: { $in: allIds } };
    const certRegex = buildLooseCertNoRegex(f.certNo);
    if (certRegex) match.certNo = certRegex;
    if (f.manufacturer) match.manufacturer = { $regex: '^' + escapeRegex(f.manufacturer), $options: 'i' };
    if (f.equipment)    match.equipment    = { $regex: '^' + escapeRegex(f.equipment), $options: 'i' };

    const project = buildProjectFromFields(req.query.fields);

    const pipeline = [
      { $match: match },
      { $addFields: { adoptedByMe: { $and: [ { $eq: ['$visibility', 'public'] }, { $in: ['$_id', adoptedIds] } ] } } },
      { $sort: sort },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
            { $project: project }
          ],
          total: [{ $count: 'count' }]
        }
      }
    ];

    const [agg] = await Certificate.aggregate(pipeline);
    const items = agg?.items || [];
    const total = agg?.total?.[0]?.count || 0;

    return res.json({ items, total, page, pageSize });
  } catch (e) {
    console.error('getMyCertificatesPaged error:', e);
    return res.status(500).json({ error: 'Failed to load paged certificates' });
  }
};

// Saját PUBLIC tanúsítványok darabszáma (superadmin override támogatással)
exports.countMyPublicCertificates = async (req, res) => {
  try {
    // Requester's role to allow superadmin override
    const roleRaw = (req.scope?.role || req.scope?.userRole || req.role || '').toString().toLowerCase();
    const isSuperAdmin = /superadmin/.test(roleRaw);

    // Default: current authenticated user
    let targetUserId = req.scope?.userId || req.user?.id || null;

    // SuperAdmin may specify any userId via query (?userId=...)
    if (isSuperAdmin && req.query && req.query.userId) {
      targetUserId = String(req.query.userId).trim();
    }

    if (!targetUserId) {
      return res.status(401).json({ message: '❌ Hiányzik a user azonosító az authból!' });
    }

    // If ObjectId-like -> cast; else keep as string (supports string-stored createdBy)
    let createdBy = targetUserId;
    const looksLikeObjectId = /^[a-fA-F0-9]{24}$/.test(String(targetUserId));
    if (looksLikeObjectId) {
      createdBy = new mongoose.Types.ObjectId(String(targetUserId));
    }

    const count = await Certificate.countDocuments({
      visibility: 'public',
      createdBy
    });

    return res.json({ userId: String(targetUserId), count });
  } catch (error) {
    console.error('❌ Hiba a countMyPublicCertificates során:', error);
    return res.status(500).json({ message: '❌ Hiba a countMyPublicCertificates során' });
  }
};

// Tanúsítvány minták – csak PUBLIC, csak minimális mezők (auth NEM szükséges)
exports.getCertificatesSamples = async (req, res) => {
  try {
    // Csak a publikus tanúsítványok és csak a szükséges mezők
    const samples = await Certificate.find({ visibility: 'public' })
      .select({ certNo: 1, manufacturer: 1, equipment: 1, _id: 0 })
      .lean();

    return res.json(samples);
  } catch (error) {
    console.error('❌ Hiba a getCertificatesSamples lekérdezés során:', error);
    return res.status(500).send('❌ Hiba a getCertificatesSamples lekérdezés során');
  }
};

exports.getCertificateByCertNo = async (req, res) => {
  try {
    const rawCertNo = req.params.certNo;
    const tenantId = req.scope?.tenantId || null;

    if (!rawCertNo || !rawCertNo.trim()) {
      return res.status(400).json({ message: '❌ Missing certNo parameter' });
    }

    // Split certNo on "/" or "," and normalize parts
    const certParts = rawCertNo
      .split(/[/,]/)
      .map(part => part.trim())
      .filter(part => part.length > 0);

    console.log('Keresett Certificate részek:', certParts);

    if (!certParts.length) {
      return res.status(400).json({ message: '❌ Invalid certNo parameter' });
    }

    const regexConditions = certParts.map(part => {
      const normalizedPart = part.replace(/\s+/g, '').toLowerCase();
      console.log('Regex keresés részletre:', normalizedPart);
      // Build a fuzzy regex: each character separated by ".*"
      return {
        certNo: {
          $regex: new RegExp(normalizedPart.split('').join('.*'), 'i')
        }
      };
    });

    console.log('Keresési feltételek:', regexConditions);

    // Scope: all PUBLIC certs + current tenant's own certs
    let visibilityFilter;
    if (tenantId) {
      const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
      visibilityFilter = {
        $or: [
          { visibility: 'public' },
          { tenantId: tenantObjectId }
        ]
      };
    } else {
      // Ha nincs tenant az auth-ból, akkor csak public cert-ek között keresünk
      visibilityFilter = { visibility: 'public' };
    }

    const certificate = await Certificate.findOne({
      ...visibilityFilter,
      $or: regexConditions
    }).lean();

    if (!certificate) {
      console.log('Certificate not found (public + own scope)');
      return res.status(404).json({ message: 'Certificate not found' });
    }

    console.log('Certificate found:', certificate);
    return res.json(certificate);
  } catch (error) {
    console.error('Error fetching certificate:', error);
    return res.status(500).send('Error fetching certificate');
  }
};

exports.resolveCertificatesBulk = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const incoming = Array.isArray(req.body?.certNos)
      ? req.body.certNos
      : [];

    const normalizedInput = Array.from(
      new Set(
        incoming
          .map(value => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      )
    );

    if (!normalizedInput.length) {
      return res.json({});
    }

    const certMap = await buildCertificateCacheForTenant(tenantId);
    const response = {};

    normalizedInput.forEach(original => {
      const certDoc = resolveCertificateFromCache(certMap, original);
      if (certDoc) {
        response[original] = {
          _id: certDoc._id,
          certNo: certDoc.certNo,
          docType: certDoc.docType || 'unknown',
          specCondition: certDoc.specCondition || '',
          issueDate: certDoc.issueDate || '',
          visibility: certDoc.visibility || 'private',
          manufacturer: certDoc.manufacturer || '',
          equipment: certDoc.equipment || ''
        };
      }
    });

    return res.json(response);
  } catch (error) {
    console.error('❌ resolveCertificatesBulk error:', error);
    return res.status(500).json({
      message: 'Failed to resolve certificates.',
      error: error.message || String(error)
    });
  }
};


exports.deleteCertificate = async (req, res) => {
  try {
    const { id } = req.params;
    const oid = tryObjectId(id);
    if (!oid) {
      return res.status(400).json({ message: '❌ Invalid certificate id' });
    }

    const certificate = await Certificate.findById(oid);
    if (!certificate) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    // Blob *paths* (container-relative) are used below for deleteFile per our azureBlobService
    try {
      if (certificate.fileUrl && typeof azureBlobService.deleteFile === 'function') {
        await azureBlobService.deleteFile(certificate.fileUrl);
      }
    } catch (e) {
      console.warn('⚠️ Blob PDF delete failed:', e.message);
    }

    // Blob *paths* (container-relative) are used below for deleteFile per our azureBlobService
    try {
      if (certificate.docxUrl && typeof azureBlobService.deleteFile === 'function') {
        await azureBlobService.deleteFile(certificate.docxUrl);
      }
    } catch (e) {
      console.warn('⚠️ Blob DOCX delete failed:', e.message);
    }

    await Certificate.findByIdAndDelete(oid);
    // töröljük a kapcsoló rekordokat is
   try {
     await CompanyCertificateLink.deleteMany({ certId: oid });
   } catch (e) {
     console.warn('⚠️ Linkek törlése sikertelen lehetett:', e?.message);
   }
    return res.json({ message: '✅ Certificate deleted successfully (Azure Blob + DB).' });
  } catch (error) {
    console.error('❌ Error deleting certificate:', error);
    return res.status(500).send('❌ Error deleting certificate');
  }
};

// Tanúsítvány módosítása ID alapján
exports.updateCertificate = async (req, res) => {
  try {
    const { id } = req.params;
    const oid = tryObjectId(id);
    if (!oid) {
      return res.status(400).json({ message: '❌ Invalid certificate id' });
    }
    const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, ucondition, specCondition, description, docType } = req.body;

    const certificate = await Certificate.findById(oid);
    if (!certificate) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    // Alap mezők frissítése
    certificate.certNo = certNo ?? certificate.certNo;
    certificate.scheme = scheme ?? certificate.scheme;
    certificate.status = status ?? certificate.status;
    certificate.issueDate = issueDate ?? certificate.issueDate;
    certificate.applicant = applicant ?? certificate.applicant;
    certificate.protection = protection ?? certificate.protection;
    certificate.equipment = equipment ?? certificate.equipment;
    certificate.manufacturer = manufacturer ?? certificate.manufacturer;
    certificate.exmarking = exmarking ?? certificate.exmarking;
    certificate.xcondition = (typeof xcondition === 'boolean') ? xcondition : (xcondition === 'true' || xcondition === '1') || certificate.xcondition;
    certificate.ucondition = (typeof ucondition === 'boolean') ? ucondition : (ucondition === 'true' || ucondition === '1') || certificate.ucondition;
    certificate.specCondition = specCondition ?? certificate.specCondition;
    certificate.description = description ?? certificate.description;
    if (typeof docType !== 'undefined') {
      certificate.docType = docType;
    }

    const prevVisibility = certificate.visibility;
    let newVisibility = prevVisibility;

    if (typeof req.body.visibility === 'string') {
      const v = req.body.visibility.toLowerCase();
      if (v === 'public' || v === 'private') {
        newVisibility = v;
      }
    } else if (typeof req.body.isPublic !== 'undefined') {
      newVisibility = (req.body.isPublic === true || req.body.isPublic === 'true') ? 'public' : 'private';
    }

    certificate.visibility = newVisibility;

    // --- VÁLTÁSOK KEZELÉSE ---
    if (prevVisibility !== 'public' && newVisibility === 'public') {
      // PRIVATE -> PUBLIC
      await certificate.save();

      // tenantId eltávolítása (updateOne, hogy a pre('save') ne rakja vissza)
      await Certificate.updateOne({ _id: certificate._id }, { $unset: { tenantId: "" } });

      // saját tenant link, hogy a listádban maradjon
      await ensureLinkForTenant(req.scope?.tenantId, certificate._id, req.scope?.userId);

      return res.json({ message: '✅ Visibility changed to PUBLIC (migrated tenantId -> null + linked)', data: certificate });
    }

    if (prevVisibility === 'public' && newVisibility !== 'public') {
      // PUBLIC -> PRIVATE
      certificate.tenantId = certificate.tenantId || req.scope?.tenantId;
      try {
        await certificate.save();
      } catch (e) {
        if (sendDuplicateError(res, e)) return;
        throw e;
      }

      // (opcionális) link törlése – nem kötelező
      // await CompanyCertificateLink.deleteOne({ tenantId: req.scope?.tenantId, certId: certificate._id });

      return res.json({ message: '✅ Visibility changed to PRIVATE (owned by tenant)', data: certificate });
    }

    // Ha nincs visibility váltás, normál mentés
    try {
      await certificate.save();
    } catch (e) {
      if (sendDuplicateError(res, e)) return;
      throw e;
    }

    return res.json({ message: '✅ Certificate updated successfully', data: certificate });
  } catch (error) {
    if (sendDuplicateError(res, error)) return;
    console.error('❌ Error updating certificate:', error);
    return res.status(500).send('❌ Error updating certificate');
  }
};

// Batch migrate certificates to public (unset tenantId and ensure link).
// Uses transactions when available; otherwise falls back to idempotent non-transactional updates.
exports.updateToPublic = async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: '❌ No certificate IDs provided!' });
  }

  const tenantId = req.scope?.tenantId;
  const userId = req.scope?.userId || req.user?.id;

  const canTx = await supportsTransactions();
  const results = [];
  let updatedCount = 0;

  if (canTx) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const id of ids) {
          try {
            const cert = await Certificate.findById(id).session(session);
            if (!cert) {
              results.push({ id, ok: false, error: 'Not found' });
              continue;
            }

            if (cert.visibility !== 'public') {
              // set to public and drop tenantId
              await Certificate.updateOne(
                { _id: id },
                { $set: { visibility: 'public' }, $unset: { tenantId: '' } },
                { session }
              );
              updatedCount++;
            }

            // ensure requesting tenant keeps seeing it
            await ensureLinkForTenant(tenantId, id, userId, session);
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: e?.message || 'Error' });
          }
        }
      });
      await session.endSession();
      return res.json({
        message: "✅ Visibility set to 'public' for selected certificates (migrated with link, transactional).",
        updatedCount,
        results
      });
    } catch (e) {
      await session.endSession();
      // Fallback when topology does not support transactions (standalone / no sessions routed)
      if (/Transaction numbers are only allowed on a replica set member or mongos/i.test(e?.message || '')) {
        // Re-run idempotently without a transaction
        updatedCount = 0;
        results.length = 0;
        for (const id of ids) {
          try {
            const cert = await Certificate.findById(id);
            if (!cert) {
              results.push({ id, ok: false, error: 'Not found' });
              continue;
            }
            if (cert.visibility !== 'public') {
              await Certificate.updateOne(
                { _id: id },
                { $set: { visibility: 'public' }, $unset: { tenantId: '' } }
              );
              updatedCount++;
            }
            await ensureLinkForTenant(tenantId, id, userId);
            results.push({ id, ok: true });
          } catch (err2) {
            results.push({ id, ok: false, error: err2?.message || 'Error' });
          }
        }
        return res.json({
          message: "✅ Visibility set to 'public' for selected certificates (migrated with link, fallback mode).",
          updatedCount,
          results
        });
      }
      // Other errors: keep previous behavior
      return res.status(500).json({
        message: '❌ Transaction failed',
        details: e?.message || String(e),
        updatedCount,
        results
      });
    }
  }

  // ---- Fallback: no transactions (standalone MongoDB) ----
  for (const id of ids) {
    try {
      const cert = await Certificate.findById(id);
      if (!cert) {
        results.push({ id, ok: false, error: 'Not found' });
        continue;
      }

      if (cert.visibility !== 'public') {
        await Certificate.updateOne(
          { _id: id },
          { $set: { visibility: 'public' }, $unset: { tenantId: '' } }
        );
        updatedCount++;
      }

      await ensureLinkForTenant(tenantId, id, userId);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e?.message || 'Error' });
    }
  }

  return res.json({
    message: "✅ Visibility set to 'public' for selected certificates (migrated with link, fallback mode).",
    updatedCount,
    results
  });
};

exports.createPreviewAtexJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId || req.user?._id;
    if (!tenantId || !userId) {
      return res.status(403).json({ error: 'Missing tenantId or user from auth' });
    }

    const fileName = safeBlobSegment(req.body?.fileName, 'preview.pdf');
    const contentType = String(req.body?.contentType || 'application/pdf');
    if (contentType !== 'application/pdf') {
      return res.status(400).json({ error: 'Preview only supports application/pdf' });
    }

    const size = Number(req.body?.size || 0);
    const scheme = String(req.body?.scheme || 'ATEX').trim() || 'ATEX';
    const jobId = crypto.randomUUID();
    const blobPath = `certificates/preview-jobs/${tenantId}/${jobId}/${fileName}`;
    const uploadUrl = await azureBlobService.getWriteSasUrl(blobPath, {
      ttlSeconds: 900,
      contentType
    });

    const job = await CertificatePreviewJob.create({
      _id: new mongoose.Types.ObjectId(),
      tenantId,
      createdBy: userId,
      status: 'created',
      scheme,
      fileName,
      contentType,
      size,
      blobPath
    });

    return res.status(201).json({
      jobId: String(job._id),
      uploadId: jobId,
      uploadUrl,
      upload: {
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': contentType
        }
      }
    });
  } catch (err) {
    console.error('[preview-job] init failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to initialize preview job' });
  }
};

exports.startPreviewAtexJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId || req.user?._id;
    const { jobId } = req.params;
    const job = await CertificatePreviewJob.findOne({ _id: jobId, tenantId, createdBy: userId });
    if (!job) return res.status(404).json({ error: 'Preview job not found' });
    if (job.status === 'processing' || job.status === 'done') {
      return res.status(202).json({ jobId, status: job.status });
    }

    await CertificatePreviewJob.updateOne(
      { _id: job._id },
      { $set: { status: 'queued', error: '' } }
    );
    processCertificatePreviewJob(job._id).catch((err) => {
      console.error('[preview-job] async processing failed:', err?.message || err);
    });

    return res.status(202).json({ jobId, status: 'queued' });
  } catch (err) {
    console.error('[preview-job] start failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to start preview job' });
  }
};

exports.getPreviewAtexJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId || req.user?._id;
    const job = await CertificatePreviewJob.findOne({
      _id: req.params.jobId,
      tenantId,
      createdBy: userId
    }).lean();
    if (!job) return res.status(404).json({ error: 'Preview job not found' });

    return res.json({
      jobId: String(job._id),
      status: job.status,
      error: job.error || '',
      recognizedText: job.status === 'done' ? (job.recognizedText || '') : '',
      extracted: job.status === 'done' ? (job.extracted || null) : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    });
  } catch (err) {
    console.error('[preview-job] get failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load preview job' });
  }
};

exports.deletePreviewAtexJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId || req.user?._id;
    const job = await CertificatePreviewJob.findOne({
      _id: req.params.jobId,
      tenantId,
      createdBy: userId
    });
    if (!job) return res.status(404).json({ error: 'Preview job not found' });

    const prefix = `certificates/preview-jobs/${tenantId}/`;
    try {
      if (job.blobPath) await azureBlobService.deleteFile(job.blobPath);
      else await azureBlobService.deletePrefix(prefix);
    } catch (e) {
      console.warn('[preview-job] blob cleanup failed:', e?.message || e);
    }
    await CertificatePreviewJob.deleteOne({ _id: job._id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[preview-job] delete failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to delete preview job' });
  }
};

// ATEX előnézet OCR+AI feldolgozással (nem ment DB-be, csak visszaadja az eredményt)
exports.previewAtex = async (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(500).send('❌ Fájl feltöltési hiba.');
    if (!req.file) {
      return res.status(400).json({ message: '❌ Hiányzó fájl a kérésben.' });
    }

    const tenantId = req.scope?.tenantId || 'n/a';
    const userId = req.scope?.userId || req.user?._id || 'n/a';
    console.info(JSON.stringify({
      level: 'info',
      message: '📥 [ATEX preview] Request received',
      tenantId,
      userId,
      fileName: req.file.originalname,
      fileSize: req.file.size
    }));

    try {
      const pdfPath = path.resolve(req.file.path);
      const pdfBuffer = fs.readFileSync(pdfPath);
      const { recognizedText, extracted } = await runCertificatePreviewFromSource({
        source: pdfBuffer,
        tenantId: req.scope?.tenantId || null,
        fileName: req.file.originalname
      });
      try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}

      return res.json({
        message: '✅ ATEX preview kész',
        recognizedText: recognizedText || '',
        extracted
      });
    } catch (error) {
      console.error('❌ Hiba ATEX preview során:', error?.response?.data || error?.message || error);
      // Cleanup temp
      try { if (req?.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
      return res.status(500).send('❌ Hiba ATEX preview során');
    }
  });
};

// Public certificate adoptálása a tenant saját listájába (link létrehozása)
exports.adoptPublic = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.user?.id;
    const { id } = req.params; // certificate _id

    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.visibility !== 'public') {
      return res.status(400).json({ message: '❌ Csak PUBLIC certificate adoptálható' });
    }

    await CompanyCertificateLink.updateOne(
      { tenantId, certId: cert._id },
      { $setOnInsert: { tenantId, certId: cert._id, addedBy: userId, addedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ message: '✅ Adoptálva a tenant listájába' });
  } catch (error) {
    if (error?.code === 11000) {
      // unique index miatt idempotens – már létezik a link
      return res.json({ message: 'ℹ️ Már adoptálva volt' });
    }
    console.error('❌ Adopt hiba:', error);
    return res.status(500).json({ message: '❌ Adopt hiba' });
  }
};

// Public certificate unadopt (link törlése a tenant listájából)
exports.unadoptPublic = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { id } = req.params; // certificate _id

    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.visibility !== 'public') {
      return res.status(400).json({ message: '❌ Csak PUBLIC certificate-ről vehető le az adopt' });
    }

    await CompanyCertificateLink.deleteOne({ tenantId, certId: cert._id });
    return res.json({ message: '✅ Eltávolítva a tenant listájáról' });
  } catch (error) {
    console.error('❌ Unadopt hiba:', error);
    return res.status(500).json({ message: '❌ Unadopt hiba' });
  }
};

// ===============================
// REPORTS on certificates (add/list/update)
// ===============================

// Helper validators for reports
const REPORT_TYPES = new Set(['fake', 'error']);
const REPORT_STATUSES = new Set(['new', 'resolved']);

/**
 * POST /api/certificates/:id/reports
 * Body: { type: 'fake'|'error', comment?: string }
 * Creates a new report on a certificate with status 'new'.
 */
exports.addReport = async (req, res) => {
  try {
    const { id } = req.params;
    const oid = tryObjectId(id);
    if (!oid) return res.status(400).json({ message: '❌ Invalid certificate id' });

    const userId = req.scope?.userId || req.user?.id || null;
    if (!userId) return res.status(401).json({ message: '❌ Missing user (auth)' });

    const type = String(req.body?.type || '').toLowerCase();
    const comment = (req.body?.comment || '').toString().trim();

    if (!REPORT_TYPES.has(type)) {
      return res.status(400).json({ message: "❌ Invalid report type. Use 'fake' or 'error'." });
    }

    // Build embedded report object (with deterministic _id for later updates)
    const reportId = new mongoose.Types.ObjectId();
    const report = {
      _id: reportId,
      type,
      comment,
      status: 'new',
      createdBy: userId,
      createdAt: new Date()
    };

    const updated = await Certificate.updateOne(
      { _id: oid },
      { $push: { reports: report } }
    );

    if (updated.matchedCount === 0) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    return res.json({ message: '✅ Report added', certificateId: String(oid), report });
  } catch (e) {
    console.error('❌ addReport error:', e?.message || e);
    return res.status(500).json({ message: '❌ Failed to add report' });
  }
};

/**
 * GET /api/certificates/:id/reports?status=new|resolved
 * Lists reports for a certificate (optionally filter by status).
 */
exports.listReports = async (req, res) => {
  try {
    const { id } = req.params;
    const oid = tryObjectId(id);
    if (!oid) return res.status(400).json({ message: '❌ Invalid certificate id' });

    const status = (req.query?.status || '').toString().toLowerCase();
    const projection = { reports: 1, _id: 0 };

    const doc = await Certificate.findById(oid).select(projection).lean();
    if (!doc) return res.status(404).json({ message: '❌ Certificate not found' });

    let reports = Array.isArray(doc.reports) ? doc.reports : [];
    if (status && REPORT_STATUSES.has(status)) {
      reports = reports.filter(r => (r?.status || '').toLowerCase() === status);
    }

    // Sort newest first
    reports.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.json({ certificateId: String(id), reports });
  } catch (e) {
    console.error('❌ listReports error:', e?.message || e);
    return res.status(500).json({ message: '❌ Failed to list reports' });
  }
};

// === LIST ALL REPORTS (global, optional status filter) ===
exports.listAllReports = async (req, res) => {
  try {
    const { status } = req.query; // 'new' | 'resolved' | undefined
    const matchStage = [];

    // csak azok a dokumentumok, ahol van reports
    matchStage.push({ $match: { reports: { $exists: true, $ne: [] } } });

    // szétbontjuk a reports tömböt
    const pipeline = [
      ...matchStage,
      { $unwind: '$reports' },
    ];

    if (status && /^(new|resolved)$/i.test(status)) {
      pipeline.push({ $match: { 'reports.status': status.toLowerCase() } });
    }

    pipeline.push(
      // hozzánézzük a bejelentőt (createdBy)
      {
        $lookup: {
          from: 'users',
          localField: 'reports.createdBy',
          foreignField: '_id',
          as: 'creator',
        }
      },
      { $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } },
      // kimeneti forma
      {
        $project: {
          _id: 0,
          certId: '$_id',
          certNo: '$certNo',
          reportId: '$reports._id',
          type: '$reports.type',
          comment: '$reports.comment',
          status: '$reports.status',
          createdAt: '$reports.createdAt',
          createdBy: {
            id: '$creator._id',
            email: '$creator.email',
            firstName: '$creator.firstName',
            lastName: '$creator.lastName'
          }
        }
      },
      { $sort: { createdAt: -1 } }
    );

    const rows = await Certificate.aggregate(pipeline);

    return res.json({ items: rows });
  } catch (e) {
    console.error('listAllReports error:', e?.message || e);
    return res.status(500).json({ error: 'Failed to list reports' });
  }
};

/**
 * PATCH /api/certificates/:id/reports/:reportId
 * Body: { status: 'new'|'resolved' }
 * Updates the status of a specific report. When resolving, sets resolvedBy/At.
 */
exports.updateReportStatus = async (req, res) => {
  try {
    const { id, reportId } = req.params;
    const oid = tryObjectId(id);
    const rid = tryObjectId(reportId);
    if (!oid || !rid) {
      return res.status(400).json({ message: '❌ Invalid certificate id or report id' });
    }

    const userId = req.scope?.userId || req.user?.id || null;
    if (!userId) return res.status(401).json({ message: '❌ Missing user (auth)' });

    const nextStatus = String(req.body?.status || '').toLowerCase();
    if (!REPORT_STATUSES.has(nextStatus)) {
      return res.status(400).json({ message: "❌ Invalid status. Use 'new' or 'resolved'." });
    }

    // Build update with arrayFilters to hit the right report item
    const now = new Date();
    const update =
      nextStatus === 'resolved'
        ? {
            $set: {
              'reports.$[r].status': 'resolved',
              'reports.$[r].resolvedBy': userId,
              'reports.$[r].resolvedAt': now
            }
          }
        : {
            $set: {
              'reports.$[r].status': 'new'
            },
            $unset: {
              'reports.$[r].resolvedBy': '',
              'reports.$[r].resolvedAt': ''
            }
          };

    const result = await Certificate.updateOne(
      { _id: oid },
      update,
      { arrayFilters: [{ 'r._id': rid }] }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }
    if (result.modifiedCount === 0) {
      return res.status(404).json({ message: '❌ Report not found on certificate' });
    }

    return res.json({ message: '✅ Report status updated', certificateId: String(oid), reportId: String(rid), status: nextStatus });
  } catch (e) {
    console.error('❌ updateReportStatus error:', e?.message || e);
    return res.status(500).json({ message: '❌ Failed to update report status' });
  }
};
