const User = require('../models/user');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');

const CRUD_ACTIONS = Object.freeze(['read', 'create', 'update', 'delete']);
const ALL_RESOURCES = Object.freeze([
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
const POWERUSER_RESOURCES = Object.freeze([
  'site',
  'zone',
  'equipment',
  'inspection',
  'maintenance',
  'customField',
  'customSchema',
  'manufacturer',
]);

function permissionsForDefaultGroup(groupName) {
  if (groupName === 'Admin') {
    return ALL_RESOURCES.map((resource) => ({ resource, actions: [...CRUD_ACTIONS] }));
  }
  return [
    ...POWERUSER_RESOURCES.map((resource) => ({ resource, actions: [...CRUD_ACTIONS] })),
    { resource: 'dashboard', actions: ['read'] },
  ];
}

function featuresFromPermissions(permissions, tenantFeatures = {}) {
  const hasActions = (resource) => {
    const row = (permissions || []).find((perm) => String(perm?.resource || '') === resource);
    return Array.isArray(row?.actions) && row.actions.length > 0;
  };
  return {
    maintenance: Boolean(tenantFeatures.maintenance && hasActions('maintenance')),
    professionRbac: Boolean(tenantFeatures.professionRbac && hasActions('user')),
    groupRbac: Boolean(tenantFeatures.groupRbac && hasActions('user')),
    customFields: Boolean(tenantFeatures.customFields && hasActions('customField')),
    customSchemas: Boolean(tenantFeatures.customSchemas && hasActions('customSchema')),
    documentation: Boolean(tenantFeatures.documentation && hasActions('documentation')),
  };
}

async function upsertDefaultGroup({ tenantId, name, description, tenantFeatures, actorUserId = null }) {
  const permissions = permissionsForDefaultGroup(name);
  return TenantAccessGroup.findOneAndUpdate(
    { tenantId, name },
    {
      $setOnInsert: {
        tenantId,
        name,
        description,
        permissions,
        features: featuresFromPermissions(permissions, tenantFeatures),
        scope: {
          allSites: true,
          siteIds: [],
          zoneIds: [],
          includeDescendants: true,
        },
        createdBy: actorUserId,
      },
      $set: {
        active: true,
        updatedBy: actorUserId,
      },
    },
    { new: true, upsert: true, runValidators: true }
  );
}

async function addMemberships({ tenantId, group, users, actorUserId = null }) {
  for (const user of users) {
    await TenantAccessGroupMembership.updateOne(
      { tenantId, groupId: group._id, userId: user._id },
      {
        $setOnInsert: {
          tenantId,
          groupId: group._id,
          userId: user._id,
          addedBy: actorUserId,
        },
      },
      { upsert: true }
    );
  }
}

async function ensureDefaultTenantAccessGroups({ tenantId, tenantFeatures = {}, actorUserId = null }) {
  const users = await User.find({
    tenantId,
    role: { $in: ['Admin', 'User'] },
  }).select('_id role email').lean();

  const adminUsers = users.filter((user) => String(user.role || '') === 'Admin');
  const powerUsers = users.filter((user) => String(user.role || '') === 'User');

  const adminGroup = await upsertDefaultGroup({
    tenantId,
    name: 'Admin',
    description: 'Default tenant admin group.',
    tenantFeatures,
    actorUserId,
  });
  const powerUserGroup = await upsertDefaultGroup({
    tenantId,
    name: 'PowerUser',
    description: 'Default tenant power user group.',
    tenantFeatures,
    actorUserId,
  });

  await addMemberships({ tenantId, group: adminGroup, users: adminUsers, actorUserId });
  await addMemberships({ tenantId, group: powerUserGroup, users: powerUsers, actorUserId });

  return {
    groups: [
      { name: adminGroup.name, id: String(adminGroup._id), membersEnsured: adminUsers.length },
      { name: powerUserGroup.name, id: String(powerUserGroup._id), membersEnsured: powerUsers.length },
    ],
  };
}

module.exports = {
  CRUD_ACTIONS,
  ALL_RESOURCES,
  POWERUSER_RESOURCES,
  permissionsForDefaultGroup,
  featuresFromPermissions,
  ensureDefaultTenantAccessGroups,
};
