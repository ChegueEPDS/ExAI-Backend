const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const mime = require('mime-types');
const Documentation = require('../models/documentation');
const DocumentationAssignment = require('../models/documentationAssignment');
const Site = require('../models/site');
const Unit = require('../models/unit');
const azureBlob = require('../services/azureBlobService');
const docService = require('../services/documentationService');
const tenantAccess = require('../services/tenantAccessService');

function toObjectId(value) {
  return docService.toObjectId(value);
}

function cleanFileName(filename) {
  return String(filename || 'document')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.\-_ ]/g, '_')
    .trim() || 'document';
}

function slug(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeDashboardScope(value) {
  const scope = String(value || '').toLowerCase();
  return scope === 'site' || scope === 'zone' ? scope : 'global';
}

function parseDashboardLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(100, Math.floor(n));
}

function isAllowedDocument(fileName, contentType) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('image/')) return false;
  const allowedExt = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.odt', '.ods'
  ]);
  if (allowedExt.has(ext)) return true;
  return [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'application/rtf',
  ].includes(type);
}

function serializeDoc(doc, assignmentCount = 0) {
  const d = doc && doc.toObject ? doc.toObject() : doc;
  return {
    _id: String(d._id),
    name: d.name,
    alias: d.alias || d.name,
    description: d.description || '',
    blobPath: d.blobPath,
    blobUrl: d.blobUrl,
    url: d.blobUrl,
    contentType: d.contentType,
    size: d.size || 0,
    expiresAt: d.expiresAt || null,
    assignmentCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

exports.listDocumentations = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    if (!tenantId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    const docs = await Documentation.find({ tenantId }).sort({ createdAt: -1 }).lean();
    const ids = docs.map((d) => d._id);
    const counts = ids.length
      ? await DocumentationAssignment.aggregate([
          { $match: { tenantId, documentationId: { $in: ids } } },
          { $group: { _id: '$documentationId', count: { $sum: 1 } } },
        ])
      : [];
    const countById = new Map(counts.map((row) => [String(row._id), row.count]));
    return res.json({ items: docs.map((d) => serializeDoc(d, countById.get(String(d._id)) || 0)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to load documentations' });
  }
};

exports.listExpiredDocumentationsForDashboard = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    if (!tenantId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const scope = normalizeDashboardScope(req.query.scope);
    const siteId = toObjectId(req.query.siteId);
    const zoneId = toObjectId(req.query.zoneId);
    const limit = parseDashboardLimit(req.query.limit);
    const now = new Date();

    let docIdFilter = null;
    if (scope === 'site') {
      if (!siteId) return res.status(400).json({ message: 'Invalid siteId' });
      await tenantAccess.assertLocationAccess(req, { siteId });
      const site = await Site.findOne({ _id: siteId, tenantId }).select('_id').lean();
      if (!site) return res.status(404).json({ message: 'Site not found' });

      const zones = await Unit.find({ tenantId, Site: siteId }).select('_id').lean();
      const zoneIds = zones.map((z) => z._id).filter(Boolean);
      const assignments = await DocumentationAssignment.find({
        tenantId,
        $or: [
          { targetType: 'site', targetId: siteId },
          ...(zoneIds.length ? [{ targetType: 'zone', targetId: { $in: zoneIds } }] : [])
        ]
      }).select('documentationId').lean();
      docIdFilter = assignments.map((a) => a.documentationId).filter(Boolean);
    }

    if (scope === 'zone') {
      if (!zoneId) return res.status(400).json({ message: 'Invalid zoneId' });
      await tenantAccess.assertLocationAccess(req, { zoneId });
      const zones = await Unit.find({
        tenantId,
        $or: [{ _id: zoneId }, { ancestors: zoneId }]
      }).select('_id').lean();
      const zoneIds = zones.map((z) => z._id).filter(Boolean);
      const assignments = zoneIds.length
        ? await DocumentationAssignment.find({
            tenantId,
            targetType: 'zone',
            targetId: { $in: zoneIds }
          }).select('documentationId').lean()
        : [];
      docIdFilter = assignments.map((a) => a.documentationId).filter(Boolean);
    }

    const query = {
      tenantId,
      expiresAt: { $ne: null, $lt: now }
    };
    if (docIdFilter) {
      const uniqueDocIds = Array.from(new Map(docIdFilter.map((id) => [String(id), id])).values());
      if (!uniqueDocIds.length) {
        return res.json({
          scope: { scope, siteId: scope === 'global' ? null : String(req.query.siteId || ''), zoneId: scope === 'zone' ? String(req.query.zoneId || '') : null },
          summary: { expired: 0 },
          items: []
        });
      }
      query._id = { $in: uniqueDocIds };
    }

    const [expiredCount, docs] = await Promise.all([
      Documentation.countDocuments(query),
      Documentation.find(query)
        .sort({ expiresAt: 1, _id: 1 })
        .limit(limit)
        .lean()
    ]);

    const ids = docs.map((d) => d._id);
    const counts = ids.length
      ? await DocumentationAssignment.aggregate([
          { $match: { tenantId, documentationId: { $in: ids } } },
          { $group: { _id: '$documentationId', count: { $sum: 1 } } }
        ])
      : [];
    const countById = new Map(counts.map((row) => [String(row._id), row.count]));

    return res.json({
      scope: { scope, siteId: scope === 'global' ? null : String(req.query.siteId || ''), zoneId: scope === 'zone' ? String(req.query.zoneId || '') : null },
      summary: { expired: expiredCount },
      items: docs.map((d) => ({
        documentationId: String(d._id),
        name: d.name,
        alias: d.alias || d.name,
        description: d.description || '',
        expiresAt: d.expiresAt || null,
        assignmentCount: countById.get(String(d._id)) || 0
      }))
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to load expired documentations' });
  }
};

exports.createDocumentation = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantId = toObjectId(tenantIdStr);
    if (!tenantId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No file provided' });

    const safeName = cleanFileName(file.originalname);
    const contentType = file.mimetype || mime.lookup(safeName) || 'application/octet-stream';
    if (!isAllowedDocument(safeName, contentType)) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ message: 'Only document files are allowed.' });
    }

    const tenantRoot = slug(req.scope?.tenantName) || `TENANT_${tenantIdStr}`;
    const suffix = `${Date.now()}_${new mongoose.Types.ObjectId()}`;
    const blobPath = `${tenantRoot}/documentations/${suffix}_${safeName}`;
    const buffer = fs.readFileSync(file.path);
    await azureBlob.uploadBuffer(blobPath, buffer, contentType);
    try { fs.unlinkSync(file.path); } catch {}

    const doc = await Documentation.create({
      tenantId,
      name: safeName,
      alias: String(req.body?.alias || '').trim() || safeName,
      description: String(req.body?.description || '').trim(),
      blobPath,
      blobUrl: azureBlob.getBlobUrl(blobPath),
      contentType,
      size: buffer.length,
      expiresAt: parseDate(req.body?.expiresAt),
      uploadedBy: req.userId || req.scope?.userId || null,
      updatedBy: req.userId || req.scope?.userId || null,
    });
    return res.status(201).json(serializeDoc(doc, 0));
  } catch (e) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    return res.status(500).json({ message: e.message || 'Failed to create documentation' });
  }
};

exports.updateDocumentation = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const docId = toObjectId(req.params.id);
    if (!tenantId || !docId) return res.status(400).json({ message: 'Invalid id' });
    const update = {
      alias: String(req.body?.alias || '').trim(),
      description: String(req.body?.description || '').trim(),
      expiresAt: parseDate(req.body?.expiresAt),
      updatedBy: req.userId || req.scope?.userId || null,
    };
    const doc = await Documentation.findOneAndUpdate(
      { _id: docId, tenantId },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: 'Documentation not found' });
    const assignmentCount = await DocumentationAssignment.countDocuments({ tenantId, documentationId: doc._id });
    return res.json(serializeDoc(doc, assignmentCount));
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to update documentation' });
  }
};

exports.deleteDocumentation = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const docId = toObjectId(req.params.id);
    if (!tenantId || !docId) return res.status(400).json({ message: 'Invalid id' });
    const assignmentCount = await DocumentationAssignment.countDocuments({ tenantId, documentationId: docId });
    if (assignmentCount > 0) {
      return res.status(409).json({ message: 'Documentation is assigned to one or more sites or zones.' });
    }
    const doc = await Documentation.findOneAndDelete({ _id: docId, tenantId }).lean();
    if (!doc) return res.status(404).json({ message: 'Documentation not found' });
    if (doc.blobPath) {
      try { await azureBlob.deleteFile(doc.blobPath); }
      catch (e) { console.warn('Documentation blob delete failed:', e?.message || e); }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to delete documentation' });
  }
};

exports.getHierarchy = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    if (!tenantId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    return res.json(await docService.loadHierarchy(tenantId));
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to load hierarchy' });
  }
};

exports.getAssignments = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const docId = toObjectId(req.params.id);
    if (!tenantId || !docId) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Documentation.findOne({ _id: docId, tenantId }).select('_id').lean();
    if (!doc) return res.status(404).json({ message: 'Documentation not found' });
    const assignments = await DocumentationAssignment.find({ tenantId, documentationId: docId }).lean();
    return res.json({
      siteIds: assignments.filter((a) => a.targetType === 'site').map((a) => String(a.targetId)),
      zoneIds: assignments.filter((a) => a.targetType === 'zone').map((a) => String(a.targetId)),
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to load assignments' });
  }
};

exports.replaceAssignments = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const docId = toObjectId(req.params.id);
    if (!tenantId || !docId) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Documentation.findOne({ _id: docId, tenantId }).select('_id').lean();
    if (!doc) return res.status(404).json({ message: 'Documentation not found' });

    const siteIds = Array.from(new Set((Array.isArray(req.body?.siteIds) ? req.body.siteIds : []).map(String))).map(toObjectId).filter(Boolean);
    const zoneIds = Array.from(new Set((Array.isArray(req.body?.zoneIds) ? req.body.zoneIds : []).map(String))).map(toObjectId).filter(Boolean);
    const desired = [
      ...siteIds.map((targetId) => ({ targetType: 'site', targetId })),
      ...zoneIds.map((targetId) => ({ targetType: 'zone', targetId })),
    ];

    for (const item of desired) {
      await docService.assertTargetForAssignment?.(req, item);
    }

    await DocumentationAssignment.deleteMany({ tenantId, documentationId: docId });
    if (desired.length) {
      await DocumentationAssignment.insertMany(
        desired.map((item) => ({
          tenantId,
          documentationId: docId,
          targetType: item.targetType,
          targetId: item.targetId,
          attachedBy: req.userId || req.scope?.userId || null,
        })),
        { ordered: false }
      );
    }
    return res.json({ siteIds: siteIds.map(String), zoneIds: zoneIds.map(String) });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to save assignments' });
  }
};

exports.attachToTarget = async (req, res) => {
  try {
    const targetType = req.params.siteId ? 'site' : 'zone';
    const targetId = req.params.siteId || req.params.zoneId;
    const doc = await docService.attachDocumentation(req, {
      documentationId: req.params.documentationId,
      targetType,
      targetId,
    });
    return res.status(201).json(doc);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to attach documentation' });
  }
};

exports.detachFromTarget = async (req, res) => {
  try {
    const targetType = req.params.siteId ? 'site' : 'zone';
    const targetId = req.params.siteId || req.params.zoneId;
    await docService.detachDocumentation(req, {
      documentationId: req.params.documentationId,
      targetType,
      targetId,
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to detach documentation' });
  }
};
