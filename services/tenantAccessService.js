const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const Unit = require('../models/unit');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');
const { computePermissions, hasAnyPermission } = require('../helpers/rbac');

const FEATURE_KEYS = Object.freeze(['maintenance', 'professionRbac', 'groupRbac', 'customFields', 'customSchemas']);

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function idString(value) {
  return value ? String(value) : '';
}

function normalizeTenantFeatures(tenant) {
  const raw = tenant?.features || {};
  const type = String(tenant?.type || '').toLowerCase();
  return {
    maintenance: type === 'personal' ? false : Boolean(raw.maintenance),
    professionRbac: Boolean(raw.professionRbac || tenant?.professionRbacEnabled),
    groupRbac: type === 'personal' ? false : Boolean(raw.groupRbac),
    customFields: Boolean(raw.customFields),
    customSchemas: Boolean(raw.customSchemas),
  };
}

function actionImplies(granted, required) {
  if (granted === '*' || granted === 'manage') return true;
  if (granted === required) return true;
  if (granted === 'update' && required === 'read') return true;
  if (granted === 'create' && required === 'read') return true;
  if (granted === 'delete' && required === 'read') return true;
  return false;
}

function groupHasPermission(group, resource, action) {
  const requiredResource = String(resource || '');
  const requiredAction = String(action || 'read');
  return (group.permissions || []).some((perm) => {
    const res = String(perm?.resource || '');
    if (res !== '*' && res !== requiredResource) return false;
    return (perm.actions || []).some((a) => actionImplies(String(a), requiredAction));
  });
}

function groupHasAnyResourceAction(group, resource) {
  const requiredResource = String(resource || '');
  return (group.permissions || []).some((perm) => {
    const res = String(perm?.resource || '');
    return (res === '*' || res === requiredResource) && Array.isArray(perm.actions) && perm.actions.length > 0;
  });
}

function groupHasFeatureAccess(group, featureKey) {
  const map = {
    maintenance: 'maintenance',
    professionRbac: 'user',
    groupRbac: 'user',
    customFields: 'customField',
    customSchemas: 'customSchema',
  };
  const resource = map[featureKey];
  return resource ? groupHasAnyResourceAction(group, resource) : false;
}

function legacyPermissionFor(resource, action) {
  const r = String(resource || '');
  const a = String(action || 'read');
  const map = {
    site: { read: 'site:read', create: 'site:write', update: 'site:write', delete: 'site:write' },
    zone: { read: 'zone:read', create: 'zone:write', update: 'zone:write', delete: 'zone:write' },
    equipment: { read: 'asset:read', create: 'asset:write', update: 'asset:write', delete: 'asset:write' },
    inspection: { read: 'inspection:read', create: 'inspection:manage', update: 'inspection:manage', delete: 'inspection:manage' },
    maintenance: { read: 'maintenance:read', create: 'maintenance:manage', update: 'maintenance:manage', delete: 'maintenance:manage' },
    customField: { read: 'asset:read', create: 'asset:write', update: 'asset:write', delete: 'asset:write' },
    customSchema: { read: 'inspection:read', create: 'inspection:manage', update: 'inspection:manage', delete: 'inspection:manage' },
    manufacturer: { read: 'asset:read', create: 'asset:write', update: 'asset:write', delete: 'asset:write' },
    dashboard: { read: 'asset:read' },
    user: { read: '*:*', create: '*:*', update: '*:*', delete: '*:*' },
  };
  return map[r]?.[a] || `${r}:${a}`;
}

function addUnique(list, value) {
  const s = idString(value);
  if (s && !list.includes(s)) list.push(s);
}

async function expandZoneIds(tenantId, zoneIds, includeDescendants = true) {
  const ids = Array.from(new Set((zoneIds || []).map(idString).filter(Boolean)));
  if (!ids.length) return [];
  if (!includeDescendants) return ids;
  const objectIds = ids.map(toObjectId).filter(Boolean);
  if (!objectIds.length) return ids;
  const descendants = await Unit.find({
    tenantId,
    $or: [{ _id: { $in: objectIds } }, { ancestors: { $in: objectIds } }],
  }).select('_id').lean();
  const out = ids.slice();
  for (const d of descendants) addUnique(out, d._id);
  return out;
}

async function loadTenant(tenantId) {
  const id = toObjectId(tenantId);
  if (!id) return null;
  return Tenant.findById(id).select('_id type features professionRbacEnabled').lean();
}

async function getUserGroups({ tenantId, userId }) {
  const t = toObjectId(tenantId);
  const u = toObjectId(userId);
  if (!t || !u) return [];
  const memberships = await TenantAccessGroupMembership.find({ tenantId: t, userId: u }).select('groupId').lean();
  const groupIds = memberships.map((m) => m.groupId).filter(Boolean);
  if (!groupIds.length) return [];
  return TenantAccessGroup.find({ tenantId: t, _id: { $in: groupIds }, active: true }).lean();
}

async function getAccessContext(reqOrUser) {
  const user = reqOrUser?.user || reqOrUser || {};
  const scope = reqOrUser?.scope || {};
  const tenantId = scope.tenantId || user.tenantId;
  const userId = scope.userId || user.id || user.userId || user._id;
  const role = String(scope.role || user.role || '');
  const tenant = await loadTenant(tenantId);
  const tenantFeatures = normalizeTenantFeatures(tenant);
  const isSuperAdmin = role === 'SuperAdmin';
  const isTenantAdmin = role === 'Admin';

  if (isSuperAdmin || isTenantAdmin || !tenantFeatures.groupRbac) {
    return {
      tenantId: idString(tenantId),
      userId: idString(userId),
      role,
      tenantFeatures,
      groupRbacEnabled: Boolean(tenantFeatures.groupRbac),
      isBypass: isSuperAdmin || isTenantAdmin,
      allSites: true,
      siteIds: [],
      zoneIds: [],
      features: { ...tenantFeatures },
      groups: [],
    };
  }

  const groups = await getUserGroups({ tenantId, userId });
  const features = {};
  for (const key of FEATURE_KEYS) {
    features[key] = tenantFeatures[key] && groups.some((g) => groupHasFeatureAccess(g, key));
  }

  const allSites = groups.some((g) => g.scope?.allSites === true);
  const siteIds = [];
  const zoneIdsRaw = [];
  let includeDescendants = true;
  for (const g of groups) {
    for (const sid of g.scope?.siteIds || []) addUnique(siteIds, sid);
    for (const zid of g.scope?.zoneIds || []) addUnique(zoneIdsRaw, zid);
    if (g.scope?.includeDescendants === false) includeDescendants = false;
  }
  const zoneIds = await expandZoneIds(tenantId, zoneIdsRaw, includeDescendants);

  return {
    tenantId: idString(tenantId),
    userId: idString(userId),
    role,
    tenantFeatures,
    groupRbacEnabled: true,
    isBypass: false,
    allSites,
    siteIds,
    zoneIds,
    features,
    groups,
  };
}

async function can(reqOrUser, resource, action) {
  const ctx = await getAccessContext(reqOrUser);
  if (ctx.isBypass) return true;
  if (!ctx.groupRbacEnabled) {
    const user = reqOrUser?.user || reqOrUser || {};
    const perms =
      Array.isArray(user.permissions) && user.permissions.length
        ? user.permissions
        : computePermissions({ role: user.role, professions: user.professions });
    return hasAnyPermission(perms, legacyPermissionFor(resource, action));
  }
  return ctx.groups.some((group) => groupHasPermission(group, resource, action));
}

async function getPermissionStrings(reqOrUser) {
  const ctx = await getAccessContext(reqOrUser);
  if (ctx.isBypass) return ['*:*'];
  if (!ctx.groupRbacEnabled) {
    const user = reqOrUser?.user || reqOrUser || {};
    return Array.isArray(user.permissions) && user.permissions.length
      ? user.permissions
      : computePermissions({ role: user.role, professions: user.professions });
  }
  const out = new Set();
  for (const group of ctx.groups || []) {
    for (const perm of group.permissions || []) {
      const resource = String(perm.resource || '').trim();
      if (!resource) continue;
      for (const action of perm.actions || []) {
        const a = String(action || '').trim();
        if (a) out.add(`${resource}:${a}`);
      }
    }
  }
  return Array.from(out);
}

async function requireAccess(req, res, next, resource, action = 'read') {
  try {
    if (!(await can(req, resource, action))) {
      return res.status(403).json({ error: 'Access denied', resource, action });
    }
    return next();
  } catch (err) {
    console.error('[tenant-access] requireAccess failed', err);
    return res.status(500).json({ error: 'Access check failed' });
  }
}

function buildScopeFilter(ctx, fields = {}) {
  if (!ctx?.groupRbacEnabled || ctx.isBypass || ctx.allSites) return {};
  const siteField = fields.siteField || 'Site';
  const zoneField = fields.zoneField || 'Zone';
  const unitField = fields.unitField || 'Unit';
  const or = [];
  const siteIds = (ctx.siteIds || []).map(toObjectId).filter(Boolean);
  const zoneIds = (ctx.zoneIds || []).map(toObjectId).filter(Boolean);
  if (siteIds.length) or.push({ [siteField]: { $in: siteIds } });
  if (zoneIds.length) {
    or.push({ [zoneField]: { $in: zoneIds } });
    if (unitField && unitField !== zoneField) or.push({ [unitField]: { $in: zoneIds } });
  }
  return or.length ? { $or: or } : { _id: { $exists: false } };
}

function buildSiteScopeFilter(ctx) {
  if (!ctx?.groupRbacEnabled || ctx.isBypass || ctx.allSites) return {};
  const or = [];
  const siteIds = (ctx.siteIds || []).map(toObjectId).filter(Boolean);
  const zoneIds = (ctx.zoneIds || []).map(toObjectId).filter(Boolean);
  if (siteIds.length) or.push({ _id: { $in: siteIds } });
  if (zoneIds.length) {
    // A zone grant should still expose the owning site in navigation.
    or.push({ _id: { $in: [] }, __zoneIdsForLookup: zoneIds });
  }
  if (!or.length) return { _id: { $exists: false } };
  const direct = or.filter((x) => !x.__zoneIdsForLookup);
  return direct.length ? { $or: direct } : { _id: { $exists: false } };
}

async function buildSiteScopeFilterWithZones(ctx) {
  if (!ctx?.groupRbacEnabled || ctx.isBypass || ctx.allSites) return {};
  const siteIds = (ctx.siteIds || []).map(toObjectId).filter(Boolean);
  const zoneIds = (ctx.zoneIds || []).map(toObjectId).filter(Boolean);
  if (zoneIds.length) {
    const zones = await Unit.find({ _id: { $in: zoneIds }, tenantId: ctx.tenantId }).select('Site').lean();
    for (const z of zones) {
      if (z.Site) siteIds.push(toObjectId(z.Site));
    }
  }
  const unique = Array.from(new Map(siteIds.filter(Boolean).map((id) => [String(id), id])).values());
  return unique.length ? { _id: { $in: unique } } : { _id: { $exists: false } };
}

async function applyScopeToQuery(req, filter, fields = {}) {
  const ctx = await getAccessContext(req);
  return { ...(filter || {}), ...buildScopeFilter(ctx, fields) };
}

function isSiteAllowed(ctx, siteId) {
  if (!ctx?.groupRbacEnabled || ctx.isBypass || ctx.allSites) return true;
  return (ctx.siteIds || []).includes(idString(siteId));
}

function isZoneAllowed(ctx, zoneId) {
  if (!ctx?.groupRbacEnabled || ctx.isBypass || ctx.allSites) return true;
  return (ctx.zoneIds || []).includes(idString(zoneId));
}

async function assertLocationAccess(req, { siteId = null, zoneId = null } = {}) {
  const ctx = await getAccessContext(req);
  if (!ctx.groupRbacEnabled || ctx.isBypass || ctx.allSites) return true;
  if (zoneId && isZoneAllowed(ctx, zoneId)) return true;
  if (siteId && isSiteAllowed(ctx, siteId)) return true;
  const err = new Error('Location is outside user access scope');
  err.status = 403;
  throw err;
}

module.exports = {
  FEATURE_KEYS,
  normalizeTenantFeatures,
  getAccessContext,
  can,
  requireAccess,
  applyScopeToQuery,
  buildScopeFilter,
  buildSiteScopeFilter,
  buildSiteScopeFilterWithZones,
  assertLocationAccess,
  isSiteAllowed,
  isZoneAllowed,
  legacyPermissionFor,
  getPermissionStrings,
};
