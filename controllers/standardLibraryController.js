const multer = require('multer');
const Standard = require('../models/standard');
const StandardClause = require('../models/standardClause');
const StandardSet = require('../models/standardSet');
const logger = require('../config/logger');
const mongoose = require('mongoose');
const { ingestStandardFiles, deleteStandard } = require('../services/standardIngestionService');
const azureBlob = require('../services/azureBlobService');
const systemSettings = require('../services/systemSettingsStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
exports.uploadMulter = upload;

async function resolveStandardIdForTenant({ tenantId, standardRef }) {
  const ref = String(standardRef || '').trim();
  if (!ref) return null;

  // If it's already a Mongo ObjectId, use it.
  if (mongoose.Types.ObjectId.isValid(ref)) return ref;

  // Otherwise, treat it as a human-readable standard identifier (e.g. "IEC 60079-7", "60079-7")
  // and resolve to the standard's _id.
  const candidates = await Standard.find({
    tenantId,
    $or: [
      { standardId: ref },
      { aliases: ref },
    ],
  })
    .select('_id standardId name')
    .limit(5)
    .lean();

  if (candidates.length === 1) return String(candidates[0]._id);

  // Try a looser match: suffix match on standardId, e.g. "60079-7" should match "IEC 60079-7"
  const loose = await Standard.find({ tenantId })
    .select('_id standardId name')
    .lean();
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = norm(ref);
  const suffixHits = loose.filter(s => norm(s.standardId).endsWith(needle)).slice(0, 5);
  if (suffixHits.length === 1) return String(suffixHits[0]._id);

  return { ambiguous: true, candidates: [...candidates, ...suffixHits].slice(0, 5) };
}

exports.listStandards = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const items = await Standard.find({ tenantId }).sort({ updatedAt: -1 }).lean();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.getStandard = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { standardRef } = req.params;
    const resolved = await resolveStandardIdForTenant({ tenantId, standardRef });
    if (!resolved) return res.status(400).json({ ok: false, error: 'missing standardRef' });
    if (typeof resolved === 'object' && resolved.ambiguous) {
      return res.status(409).json({
        ok: false,
        error: 'Ambiguous standardRef. Use the Mongo _id instead.',
        candidates: resolved.candidates || [],
      });
    }
    const std = await Standard.findOne({ _id: resolved, tenantId }).lean();
    if (!std) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, standard: std });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

// Return a short-lived SAS URL for the primary PDF of a tenant standard.
// Frontend uses this to open the PDF directly from Blob Storage.
exports.getStandardPdfUrl = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { standardRef } = req.params;

    const resolved = await resolveStandardIdForTenant({ tenantId, standardRef });
    if (!resolved) return res.status(400).json({ ok: false, error: 'missing standardRef' });
    if (typeof resolved === 'object' && resolved.ambiguous) {
      return res.status(409).json({
        ok: false,
        error: 'Ambiguous standardRef. Use the Mongo _id instead.',
        candidates: resolved.candidates || [],
      });
    }

    const std = await Standard.findOne({ _id: resolved, tenantId }).lean();
    if (!std) return res.status(404).json({ ok: false, error: 'not found' });

    const files = Array.isArray(std?.sourceFiles) ? std.sourceFiles : [];
    const pdf = files.find(f =>
      String(f?.contentType || '').toLowerCase().includes('pdf') ||
      String(f?.filename || '').toLowerCase().endsWith('.pdf') ||
      String(f?.blobPath || '').toLowerCase().endsWith('.pdf')
    );
    if (!pdf?.blobPath) return res.status(404).json({ ok: false, error: 'no pdf source file' });

    const ttlSeconds = Math.max(60, Math.min(Number(systemSettings.getNumber('STANDARD_PDF_SAS_TTL_SECONDS') || 600), 3600));
    const url = await azureBlob.getReadSasUrl(String(pdf.blobPath), {
      ttlSeconds,
      filename: String(pdf.filename || `${std.standardId || std.name || 'standard'}.pdf`),
      contentType: 'application/pdf',
      httpsOnly: true,
    });

    return res.json({
      ok: true,
      standardRef: String(std._id),
      standardId: String(std.standardId || ''),
      edition: String(std.edition || ''),
      filename: String(pdf.filename || ''),
      url,
      ttlSeconds,
    });
  } catch (e) {
    try { logger.error('standards.pdf.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.uploadStandard = [
  upload.array('files', 10),
  async (req, res) => {
    try {
      const tenantId = req.scope?.tenantId;
      const userId = req.userId;
      const name = String(req.body?.name || '').trim();
      const standardId = String(req.body?.standardId || '').trim();
      const edition = String(req.body?.edition || '').trim();
      // Optional: assign this standard to one or more standard sets.
      // Accept either:
      // - setIds: JSON string '["..."]' or array
      // - setKeys: JSON string or array
      let setIds = [];
      let setKeys = [];
      if (Array.isArray(req.body?.setIds)) setIds = req.body.setIds;
      else if (typeof req.body?.setIds === 'string' && req.body.setIds.trim()) {
        try { setIds = JSON.parse(req.body.setIds); } catch { setIds = []; }
      }
      if (Array.isArray(req.body?.setKeys)) setKeys = req.body.setKeys;
      else if (typeof req.body?.setKeys === 'string' && req.body.setKeys.trim()) {
        try { setKeys = JSON.parse(req.body.setKeys); } catch { setKeys = []; }
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');
      try {
        logger.info('standards.upload.start', {
          requestId: req.requestId,
          tenantId: String(tenantId || ''),
          userId: String(userId || ''),
          name,
          standardId,
          edition,
          files: files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
          setIdsCount: setIds.length,
          setKeysCount: setKeys.length,
        });
      } catch { }
      const out = await ingestStandardFiles({ tenantId, createdBy: userId, name, standardId, edition, files });
      if (debugEnabled) {
        try { logger.info('standards.upload.ingested', { requestId: req.requestId, standardRef: String(out?.standard?._id || ''), clauses: out?.clauses }); } catch { }
      }

      // Attach to sets (best-effort; do not fail the whole upload if this fails)
      try {
        const stdRef = out?.standard?._id;
        if (stdRef && (setIds.length || setKeys.length)) {
          const filt = { tenantId };
          if (setIds.length) filt._id = { $in: setIds.map(String) };
          if (!setIds.length && setKeys.length) filt.key = { $in: setKeys.map(String) };
          await StandardSet.updateMany(filt, { $addToSet: { standardRefs: stdRef } });
        }
      } catch (e) {
        // swallow: association can be fixed later via UI
      }

      return res.status(201).json({ ok: true, ...out });
    } catch (e) {
      try { logger.error('standards.upload.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
      return res.status(400).json({ ok: false, error: e?.message || 'failed' });
    }
  }
];

exports.deleteStandard = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { standardRef } = req.params;
    try { logger.info('standards.delete.start', { requestId: req.requestId, tenantId: String(tenantId || ''), standardRef: String(standardRef || '') }); } catch { }
    const resolved = await resolveStandardIdForTenant({ tenantId, standardRef });
    if (!resolved) return res.status(400).json({ ok: false, error: 'missing standardRef' });
    if (typeof resolved === 'object' && resolved.ambiguous) {
      return res.status(409).json({
        ok: false,
        error: 'Ambiguous standardRef. Use the Mongo _id instead.',
        candidates: resolved.candidates || [],
      });
    }
    await deleteStandard({ tenantId, standardRef: resolved });
    try { logger.info('standards.delete.done', { requestId: req.requestId, standardRef: String(standardRef || '') }); } catch { }
    return res.json({ ok: true });
  } catch (e) {
    try { logger.error('standards.delete.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.listStandardSets = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const items = await StandardSet.find({ tenantId }).sort({ updatedAt: -1 }).populate('standardRefs').lean();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.createStandardSet = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const rawKey = String(req.body?.key || '').trim();
    const name = String(req.body?.name || '').trim();
    const modeHint = String(req.body?.modeHint || 'unknown').trim();
    const standardRefs = Array.isArray(req.body?.standardRefs) ? req.body.standardRefs : [];
    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.map(String) : [];
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

    const normalizeKey = (s) =>
      String(s || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);

    let key = rawKey ? normalizeKey(rawKey) : '';
    if (!key) {
      const base = normalizeKey(name) || 'STANDARD_SET';
      key = base;
      // ensure uniqueness within tenant
      for (let i = 0; i < 50; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const exists = await StandardSet.exists({ tenantId, key });
        if (!exists) break;
        key = `${base}_${i + 2}`;
      }
    }

    const doc = await StandardSet.create({ tenantId, key, name, modeHint, standardRefs, aliases });
    const populated = await StandardSet.findById(doc._id).populate('standardRefs').lean();
    return res.status(201).json({ ok: true, standardSet: populated });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.deleteStandardSet = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { setId } = req.params;
    await StandardSet.deleteOne({ _id: setId, tenantId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.listStandardClauses = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { standardRef } = req.params;
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
    const resolved = await resolveStandardIdForTenant({ tenantId, standardRef });
    if (!resolved) return res.status(400).json({ ok: false, error: 'missing standardRef' });
    if (typeof resolved === 'object' && resolved.ambiguous) {
      return res.status(409).json({
        ok: false,
        error: 'Ambiguous standardRef. Use the Mongo _id instead.',
        candidates: resolved.candidates || [],
      });
    }
    const items = await StandardClause.find({ tenantId, standardRef: resolved })
      .select('standardId edition clauseId title pageOrLoc quoteId')
      .sort({ clauseId: 1 })
      .limit(limit)
      .lean();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};
