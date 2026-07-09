const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const Site = require('../models/site');
const Unit = require('../models/unit');
const User = require('../models/user');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');
const { normalizeTenantFeatures } = require('../services/tenantAccessService');

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function canManageTenant(req, tenantId) {
  const role = String(req.role || req.user?.role || '');
  if (role === 'SuperAdmin') return true;
  if (role !== 'Admin') return false;
  return String(req.scope?.tenantId || '') === String(tenantId || '');
}

async function loadTenantForManage(req, tenantId) {
  const id = toObjectId(tenantId);
  if (!id) {
    const err = new Error('Invalid tenantId');
    err.status = 400;
    throw err;
  }
  if (!canManageTenant(req, id)) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
  const tenant = await Tenant.findById(id).select('_id name type features professionRbacEnabled').lean();
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }
  return tenant;
}

function normalizePermissions(input) {
  const allowedActions = new Set(['read', 'create', 'update', 'delete', 'manage']);
  const allowedResources = new Set([
    'site',
    'zone',
    'equipment',
    'inspection',
    'maintenance',
    'customField',
    'customSchema',
    'manufacturer',
    'dashboard',
    'documentation',
    'user',
  ]);
  const out = [];
  for (const row of Array.isArray(input) ? input : []) {
    const resource = String(row?.resource || '').trim();
    if (!allowedResources.has(resource)) continue;
    const actions = Array.from(new Set((row?.actions || []).map((a) => String(a || '').trim()).filter((a) => allowedActions.has(a))));
    out.push({ resource, actions });
  }
  return out;
}

function normalizeFeatures(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    maintenance: Boolean(raw.maintenance),
    professionRbac: Boolean(raw.professionRbac),
    groupRbac: Boolean(raw.groupRbac),
    customFields: Boolean(raw.customFields),
    customSchemas: Boolean(raw.customSchemas),
    documentation: Boolean(raw.documentation),
  };
}

function hasAnyActions(permissions, resource) {
  const row = (permissions || []).find((perm) => String(perm?.resource || '') === resource);
  return Array.isArray(row?.actions) && row.actions.length > 0;
}

function deriveFeaturesFromPermissions(permissions) {
  return {
    maintenance: hasAnyActions(permissions, 'maintenance'),
    professionRbac: hasAnyActions(permissions, 'user'),
    groupRbac: hasAnyActions(permissions, 'user'),
    customFields: hasAnyActions(permissions, 'customField'),
    customSchemas: hasAnyActions(permissions, 'customSchema'),
    documentation: hasAnyActions(permissions, 'documentation'),
  };
}

function resourceEnabledForTenant(resource, tenantFeatures = {}) {
  if (resource === 'maintenance') return tenantFeatures.maintenance === true;
  if (resource === 'customField') return tenantFeatures.customFields === true;
  if (resource === 'customSchema') return tenantFeatures.customSchemas === true;
  if (resource === 'documentation') return tenantFeatures.documentation === true;
  return true;
}

function normalizeScope(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    allSites: Boolean(raw.allSites),
    siteIds: (Array.isArray(raw.siteIds) ? raw.siteIds : []).map(toObjectId).filter(Boolean),
    zoneIds: (Array.isArray(raw.zoneIds) ? raw.zoneIds : []).map(toObjectId).filter(Boolean),
    includeDescendants: raw.includeDescendants !== false,
  };
}

function groupJson(group, members = []) {
  return {
    _id: String(group._id),
    tenantId: String(group.tenantId),
    name: group.name,
    description: group.description || '',
    active: group.active !== false,
    permissions: group.permissions || [],
    features: normalizeFeatures(group.features),
    scope: {
      allSites: Boolean(group.scope?.allSites),
      siteIds: (group.scope?.siteIds || []).map(String),
      zoneIds: (group.scope?.zoneIds || []).map(String),
      includeDescendants: group.scope?.includeDescendants !== false,
    },
    memberUserIds: members.map((m) => String(m.userId)),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

exports.getTenantAccessConfig = async (req, res) => {
  try {
    const tenant = await loadTenantForManage(req, req.params.tenantId);
    const tenantId = tenant._id;
    const [groups, memberships, sites, zones, users] = await Promise.all([
      TenantAccessGroup.find({ tenantId }).sort({ name: 1 }).lean(),
      TenantAccessGroupMembership.find({ tenantId }).lean(),
      Site.find({ tenantId }).select('_id Name Client').sort({ Name: 1 }).lean(),
      Unit.find({ tenantId }).select('_id Name Site parentUnitId ancestors depth').sort({ Site: 1, depth: 1, Name: 1 }).lean(),
      User.find({ tenantId }).select('_id firstName lastName email role').sort({ firstName: 1, lastName: 1 }).lean(),
    ]);
    const byGroup = new Map();
    for (const m of memberships) {
      const key = String(m.groupId);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(m);
    }
    return res.json({
      tenant: {
        _id: String(tenant._id),
        name: tenant.name,
        type: tenant.type,
        features: normalizeTenantFeatures(tenant),
      },
      groups: groups.map((g) => groupJson(g, byGroup.get(String(g._id)) || [])),
      hierarchy: {
        sites: sites.map((s) => ({ _id: String(s._id), name: s.Name, client: s.Client || '' })),
        zones: zones.map((z) => ({
          _id: String(z._id),
          name: z.Name,
          siteId: z.Site ? String(z.Site) : '',
          parentUnitId: z.parentUnitId ? String(z.parentUnitId) : null,
          ancestors: (z.ancestors || []).map(String),
          depth: z.depth || 0,
        })),
      },
      users: users.map((u) => ({
        _id: String(u._id),
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
        email: u.email,
        role: u.role,
      })),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to load access config' });
  }
};

exports.upsertAccessGroup = async (req, res) => {
  try {
    const tenant = await loadTenantForManage(req, req.params.tenantId);
    const tenantId = tenant._id;
    const groupId = req.params.groupId ? toObjectId(req.params.groupId) : null;
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) return res.status(400).json({ message: 'Group name is required.' });

    const tenantFeatures = normalizeTenantFeatures(tenant);
    const permissions = normalizePermissions(req.body?.permissions)
      .filter((permission) => resourceEnabledForTenant(permission.resource, tenantFeatures));
    const payload = {
      tenantId,
      name,
      description: String(req.body?.description || '').trim(),
      active: req.body?.active !== false,
      permissions,
      scope: normalizeScope(req.body?.scope),
      updatedBy: req.scope?.userId || req.user?.id || null,
    };
    payload.features = deriveFeaturesFromPermissions(payload.permissions);
    if (!groupId) payload.createdBy = payload.updatedBy;

    const group = groupId
      ? await TenantAccessGroup.findOneAndUpdate({ _id: groupId, tenantId }, payload, { new: true, runValidators: true })
      : await TenantAccessGroup.create(payload);
    if (!group) return res.status(404).json({ message: 'Group not found.' });

    if (Array.isArray(req.body?.memberUserIds)) {
      const memberIds = Array.from(new Set(req.body.memberUserIds.map(toObjectId).filter(Boolean).map(String)));
      const validUsers = await User.find({ _id: { $in: memberIds.map(toObjectId).filter(Boolean) }, tenantId }).select('_id').lean();
      const validIds = validUsers.map((u) => String(u._id));
      await TenantAccessGroupMembership.deleteMany({ tenantId, groupId: group._id, userId: { $nin: validIds.map(toObjectId).filter(Boolean) } });
      const ops = validIds.map((userId) => ({
        updateOne: {
          filter: { tenantId, groupId: group._id, userId },
          update: { $setOnInsert: { tenantId, groupId: group._id, userId, addedBy: payload.updatedBy } },
          upsert: true,
        },
      }));
      if (ops.length) await TenantAccessGroupMembership.bulkWrite(ops, { ordered: false });
    }

    const memberships = await TenantAccessGroupMembership.find({ tenantId, groupId: group._id }).lean();
    return res.json(groupJson(group.toObject ? group.toObject() : group, memberships));
  } catch (e) {
    return res.status(e.status || (e.code === 11000 ? 409 : 500)).json({
      message: e.code === 11000 ? 'Group name already exists.' : (e.message || 'Failed to save group'),
    });
  }
};

exports.listAccessGroups = async (req, res) => {
  try {
    const tenant = await loadTenantForManage(req, req.params.tenantId);
    const groups = await TenantAccessGroup.find({ tenantId: tenant._id, active: { $ne: false } })
      .select('_id name description active')
      .sort({ name: 1 })
      .lean();
    return res.json({
      items: groups.map((g) => ({
        _id: String(g._id),
        name: g.name,
        description: g.description || '',
        active: g.active !== false,
      })),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to load access groups' });
  }
};

exports.getUserAccessGroups = async (req, res) => {
  try {
    const userId = toObjectId(req.params.userId);
    if (!userId) return res.status(400).json({ message: 'Invalid userId.' });
    const user = await User.findById(userId).select('_id tenantId').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    await loadTenantForManage(req, user.tenantId);
    const memberships = await TenantAccessGroupMembership.find({ tenantId: user.tenantId, userId }).select('groupId').lean();
    return res.json({
      tenantId: user.tenantId ? String(user.tenantId) : null,
      groupIds: memberships.map((m) => String(m.groupId)),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to load user access groups' });
  }
};

exports.updateUserAccessGroups = async (req, res) => {
  try {
    const userId = toObjectId(req.params.userId);
    if (!userId) return res.status(400).json({ message: 'Invalid userId.' });
    const user = await User.findById(userId).select('_id tenantId').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const tenant = await loadTenantForManage(req, user.tenantId);
    const tenantId = tenant._id;
    const groupIds = Array.from(new Set((Array.isArray(req.body?.groupIds) ? req.body.groupIds : []).map(toObjectId).filter(Boolean).map(String)));
    const validGroups = await TenantAccessGroup.find({
      _id: { $in: groupIds.map(toObjectId).filter(Boolean) },
      tenantId,
      active: { $ne: false },
    }).select('_id').lean();
    const validIds = validGroups.map((g) => String(g._id));

    await TenantAccessGroupMembership.deleteMany({ tenantId, userId, groupId: { $nin: validIds.map(toObjectId).filter(Boolean) } });
    const ops = validIds.map((groupId) => ({
      updateOne: {
        filter: { tenantId, groupId, userId },
        update: { $setOnInsert: { tenantId, groupId, userId, addedBy: req.scope?.userId || req.user?.id || null } },
        upsert: true,
      },
    }));
    if (ops.length) await TenantAccessGroupMembership.bulkWrite(ops, { ordered: false });
    return res.json({ tenantId: String(tenantId), groupIds: validIds });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to update user access groups' });
  }
};

exports.deleteAccessGroup = async (req, res) => {
  try {
    const tenant = await loadTenantForManage(req, req.params.tenantId);
    const groupId = toObjectId(req.params.groupId);
    if (!groupId) return res.status(400).json({ message: 'Invalid groupId.' });
    const deleted = await TenantAccessGroup.findOneAndDelete({ _id: groupId, tenantId: tenant._id }).lean();
    if (!deleted) return res.status(404).json({ message: 'Group not found.' });
    await TenantAccessGroupMembership.deleteMany({ tenantId: tenant._id, groupId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || 'Failed to delete group' });
  }
};
