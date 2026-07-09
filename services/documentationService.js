const mongoose = require('mongoose');
const Site = require('../models/site');
const Unit = require('../models/unit');
const User = require('../models/user');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');
const Documentation = require('../models/documentation');
const DocumentationAssignment = require('../models/documentationAssignment');
const tenantAccess = require('./tenantAccessService');

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function idString(value) {
  return value ? String(value) : '';
}

function actionImplies(granted, required) {
  if (granted === '*' || granted === 'manage') return true;
  if (granted === required) return true;
  if (granted === 'update' && required === 'read') return true;
  if (granted === 'create' && required === 'read') return true;
  if (granted === 'delete' && required === 'read') return true;
  return false;
}

function groupAllowsDocumentationUpdate(group) {
  return (group.permissions || []).some((perm) => {
    const resource = String(perm?.resource || '');
    if (resource !== '*' && resource !== 'documentation') return false;
    return (perm.actions || []).some((a) => actionImplies(String(a), 'update'));
  });
}

function normalizeGlobalDoc(doc, assignment = null) {
  if (!doc) return null;
  const d = doc.toObject ? doc.toObject() : doc;
  const a = assignment && assignment.toObject ? assignment.toObject() : assignment;
  return {
    _id: a?._id ? String(a._id) : String(d._id),
    documentationId: String(d._id),
    assignmentId: a?._id ? String(a._id) : null,
    name: d.name,
    alias: d.alias || d.name,
    description: d.description || '',
    blobPath: d.blobPath,
    blobUrl: d.blobUrl,
    url: d.blobUrl,
    contentType: d.contentType,
    size: d.size || 0,
    type: 'document',
    source: 'global',
    targetType: a?.targetType || null,
    targetId: a?.targetId ? String(a.targetId) : null,
    expiresAt: d.expiresAt || null,
    uploadedAt: d.createdAt || null,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

function normalizeLocalDoc(doc) {
  const d = doc && doc.toObject ? doc.toObject() : doc;
  return {
    ...(d || {}),
    _id: d?._id ? String(d._id) : d?._id,
    source: 'local',
  };
}

async function loadGlobalFilesForTarget({ tenantId, targetType, targetId }) {
  const t = toObjectId(tenantId);
  const target = toObjectId(targetId);
  if (!t || !target) return [];
  const assignments = await DocumentationAssignment.find({ tenantId: t, targetType, targetId: target }).lean();
  if (!assignments.length) return [];
  const docIds = assignments.map((a) => a.documentationId).filter(Boolean);
  const docs = await Documentation.find({ tenantId: t, _id: { $in: docIds } }).lean();
  const docById = new Map(docs.map((d) => [String(d._id), d]));
  return assignments
    .map((a) => normalizeGlobalDoc(docById.get(String(a.documentationId)), a))
    .filter(Boolean);
}

async function mergeFilesForSite(site, tenantId) {
  const local = (site?.documents || []).map(normalizeLocalDoc);
  const global = await loadGlobalFilesForTarget({ tenantId, targetType: 'site', targetId: site?._id });
  return [...local, ...global];
}

async function mergeFilesForZone(zone, tenantId) {
  const local = (zone?.documents || []).map(normalizeLocalDoc);
  const global = await loadGlobalFilesForTarget({ tenantId, targetType: 'zone', targetId: zone?._id });
  return [...local, ...global];
}

async function assertTargetForAssignment(req, { targetType, targetId }) {
  const tenantId = toObjectId(req.scope?.tenantId);
  const targetObjectId = toObjectId(targetId);
  if (!tenantId) {
    const err = new Error('Invalid or missing tenantId in auth');
    err.status = 400;
    throw err;
  }
  if (!targetObjectId || !['site', 'zone'].includes(String(targetType))) {
    const err = new Error('Invalid target');
    err.status = 400;
    throw err;
  }

  if (targetType === 'site') {
    await tenantAccess.assertLocationAccess(req, { siteId: targetObjectId });
    const site = await Site.findOne({ _id: targetObjectId, tenantId }).select('_id').lean();
    if (!site) {
      const err = new Error('Site not found');
      err.status = 404;
      throw err;
    }
    return site;
  }

  await tenantAccess.assertLocationAccess(req, { zoneId: targetObjectId });
  const zone = await Unit.findOne({ _id: targetObjectId, tenantId }).select('_id Site').lean();
  if (!zone) {
    const err = new Error('Zone not found');
    err.status = 404;
    throw err;
  }
  return zone;
}

async function attachDocumentation(req, { documentationId, targetType, targetId }) {
  const tenantId = toObjectId(req.scope?.tenantId);
  const docId = toObjectId(documentationId);
  const targetObjectId = toObjectId(targetId);
  if (!tenantId || !docId || !targetObjectId) {
    const err = new Error('Invalid documentation or target id');
    err.status = 400;
    throw err;
  }
  const doc = await Documentation.findOne({ _id: docId, tenantId }).lean();
  if (!doc) {
    const err = new Error('Documentation not found');
    err.status = 404;
    throw err;
  }
  await assertTargetForAssignment(req, { targetType, targetId: targetObjectId });
  const assignment = await DocumentationAssignment.findOneAndUpdate(
    { tenantId, documentationId: docId, targetType, targetId: targetObjectId },
    { $setOnInsert: { tenantId, documentationId: docId, targetType, targetId: targetObjectId, attachedBy: req.userId || req.scope?.userId || null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return normalizeGlobalDoc(doc, assignment);
}

async function detachDocumentation(req, { documentationId, targetType, targetId }) {
  const tenantId = toObjectId(req.scope?.tenantId);
  const docId = toObjectId(documentationId);
  const targetObjectId = toObjectId(targetId);
  if (!tenantId || !docId || !targetObjectId) {
    const err = new Error('Invalid documentation or target id');
    err.status = 400;
    throw err;
  }
  await assertTargetForAssignment(req, { targetType, targetId: targetObjectId });
  const deleted = await DocumentationAssignment.findOneAndDelete({
    tenantId,
    documentationId: docId,
    targetType,
    targetId: targetObjectId,
  }).lean();
  if (!deleted) {
    const err = new Error('Documentation assignment not found');
    err.status = 404;
    throw err;
  }
  return { ok: true };
}

async function loadHierarchy(tenantId) {
  const t = toObjectId(tenantId);
  if (!t) return { sites: [], zones: [] };
  const [sites, zones] = await Promise.all([
    Site.find({ tenantId: t }).select('_id Name Client').sort({ Name: 1 }).lean(),
    Unit.find({ tenantId: t }).select('_id Name Site parentUnitId ancestors depth').sort({ Site: 1, depth: 1, Name: 1 }).lean(),
  ]);
  return {
    sites: sites.map((s) => ({ _id: idString(s._id), name: s.Name, client: s.Client || '' })),
    zones: zones.map((z) => ({
      _id: idString(z._id),
      name: z.Name,
      siteId: idString(z.Site),
      parentUnitId: z.parentUnitId ? idString(z.parentUnitId) : null,
      ancestors: (z.ancestors || []).map(idString),
      depth: z.depth || 0,
    })),
  };
}

async function usersWhoCanUpdateDocumentation(tenantId) {
  const t = toObjectId(tenantId);
  if (!t) return [];
  const users = await User.find({ tenantId: t, role: { $in: ['Admin', 'SuperAdmin'] } }).select('_id email role').lean();
  const byId = new Map(users.map((u) => [idString(u._id), u]));
  const groups = await TenantAccessGroup.find({ tenantId: t, active: true }).lean();
  const allowedGroupIds = groups.filter(groupAllowsDocumentationUpdate).map((g) => g._id);
  if (allowedGroupIds.length) {
    const memberships = await TenantAccessGroupMembership.find({ tenantId: t, groupId: { $in: allowedGroupIds } }).select('userId').lean();
    const memberIds = memberships.map((m) => toObjectId(m.userId)).filter(Boolean);
    if (memberIds.length) {
      const memberUsers = await User.find({ _id: { $in: memberIds }, tenantId: t }).select('_id email role').lean();
      for (const user of memberUsers) byId.set(idString(user._id), user);
    }
  }
  return Array.from(byId.values());
}

module.exports = {
  toObjectId,
  normalizeGlobalDoc,
  normalizeLocalDoc,
  mergeFilesForSite,
  mergeFilesForZone,
  assertTargetForAssignment,
  attachDocumentation,
  detachDocumentation,
  loadHierarchy,
  usersWhoCanUpdateDocumentation,
};
