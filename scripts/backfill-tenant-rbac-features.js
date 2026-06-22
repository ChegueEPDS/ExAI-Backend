require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Tenant = require('../models/tenant');
const User = require('../models/user');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');
const CustomFieldDefinition = require('../models/customFieldDefinition');
const FieldLayout = require('../models/fieldLayout');
const SchemaDefinition = require('../models/schemaDefinition');
const MaintenanceEvent = require('../models/maintenanceEvent');
const MaintenanceActivity = require('../models/maintenanceActivity');
const { getEffectiveProfessions } = require('../helpers/rbac');
const {
  ALL_RESOURCES,
  featuresFromPermissions,
  ensureDefaultTenantAccessGroups,
} = require('../services/defaultTenantAccessGroups');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function bool(value) {
  return value === true;
}

function countMap(rows) {
  return new Map((rows || []).map((row) => [String(row._id), row.count || 0]));
}

async function countsByTenant(Model, match = {}) {
  return countMap(await Model.aggregate([
    { $match: match },
    { $group: { _id: '$tenantId', count: { $sum: 1 } } }
  ]));
}

function tenantHas(counts, tenantId) {
  return (counts.get(String(tenantId)) || 0) > 0;
}

function inferFeatures(tenant, usage, options = {}) {
  const raw = tenant.features || {};
  const isPersonal = String(tenant.type || '').toLowerCase() === 'personal';
  const tenantId = tenant._id;
  const hasMaintenanceData =
    tenantHas(usage.maintenanceEvents, tenantId) ||
    tenantHas(usage.maintenanceActivities, tenantId) ||
    tenantHas(usage.maintenanceSchemas, tenantId);
  const hasCustomFieldData =
    tenantHas(usage.customFieldDefinitions, tenantId) ||
    tenantHas(usage.customFieldLayouts, tenantId);
  const hasTenantSchemas = tenantHas(usage.tenantSchemas, tenantId);

  return {
    maintenance: isPersonal ? false : (hasOwn(raw, 'maintenance') ? bool(raw.maintenance) : hasMaintenanceData),
    professionRbac: hasOwn(raw, 'professionRbac') ? bool(raw.professionRbac) : bool(tenant.professionRbacEnabled),
    groupRbac: isPersonal ? false : (hasOwn(raw, 'groupRbac') ? bool(raw.groupRbac) : Boolean(options.enableGroupRbac && tenantHas(usage.groups, tenantId))),
    customFields: hasOwn(raw, 'customFields') ? bool(raw.customFields) : hasCustomFieldData,
    customSchemas: hasOwn(raw, 'customSchemas') ? bool(raw.customSchemas) : hasTenantSchemas,
  };
}

function permissionsForLegacyGroup(groupKey) {
  if (groupKey === 'manager') {
    return ALL_RESOURCES.map((resource) => ({ resource, actions: ['manage'] }));
  }
  if (groupKey === 'operative') {
    return [
      { resource: 'site', actions: ['read'] },
      { resource: 'zone', actions: ['read'] },
      { resource: 'equipment', actions: ['read'] },
      { resource: 'inspection', actions: ['read'] },
      { resource: 'maintenance', actions: ['read', 'create'] },
      { resource: 'dashboard', actions: ['read'] },
      { resource: 'manufacturer', actions: ['read'] },
    ];
  }
  if (groupKey === 'ex_inspector') {
    return [
      { resource: 'site', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'zone', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'equipment', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'inspection', actions: ['manage'] },
      { resource: 'maintenance', actions: ['read', 'create'] },
      { resource: 'customField', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'customSchema', actions: ['read'] },
      { resource: 'manufacturer', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'dashboard', actions: ['read'] },
    ];
  }
  if (groupKey === 'technician') {
    return [
      { resource: 'site', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'zone', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'equipment', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'inspection', actions: ['read'] },
      { resource: 'maintenance', actions: ['manage'] },
      { resource: 'customField', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'manufacturer', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'dashboard', actions: ['read'] },
    ];
  }
  return permissionsForLegacyGroup('operative');
}

async function upsertGroupWithMembers({ tenantId, name, description, permissions, features, members, apply }) {
  if (!apply) return;
  const group = await TenantAccessGroup.findOneAndUpdate(
    { tenantId, name },
    {
      $setOnInsert: {
        tenantId,
        name,
        description,
      },
      $set: {
        active: true,
        permissions,
        features,
        scope: {
          allSites: true,
          siteIds: [],
          zoneIds: [],
          includeDescendants: true,
        },
      },
    },
    { new: true, upsert: true, runValidators: true }
  );

  for (const user of members) {
    await TenantAccessGroupMembership.updateOne(
      { tenantId, groupId: group._id, userId: user._id },
      { $setOnInsert: { tenantId, groupId: group._id, userId: user._id } },
      { upsert: true }
    );
  }
}

async function seedDefaultGroupsForTenant({ tenant, features, users, apply }) {
  if (String(tenant.type || '').toLowerCase() === 'personal') {
    return [];
  }

  const tenantId = tenant._id;
  const tenantUsers = users.filter((user) => String(user.tenantId || '') === String(tenantId));
  const groups = [
    {
      key: 'admin',
      name: 'Admin',
      description: 'Default tenant admin group created by RBAC backfill.',
      members: tenantUsers.filter((user) => String(user.role || '') === 'Admin'),
    },
    {
      key: 'poweruser',
      name: 'PowerUser',
      description: 'Default tenant power user group created by RBAC backfill.',
      members: tenantUsers.filter((user) => String(user.role || '') === 'User'),
    },
  ];

  const planned = [];
  for (const group of groups) {
    planned.push({
      groupKey: group.key,
      name: group.name,
      members: group.members.map((u) => String(u._id)),
    });
  }

  if (apply) {
    await ensureDefaultTenantAccessGroups({
      tenantId,
      tenantFeatures: features,
    });
  }

  return planned;
}

function legacyGroupName(groupKey) {
  const labels = {
    manager: 'Legacy Managers',
    operative: 'Legacy Operatives',
    ex_inspector: 'Legacy Ex Inspectors',
    technician: 'Legacy Technicians',
  };
  return labels[groupKey] || labels.operative;
}

function groupKeyForUser(user) {
  const professions = getEffectiveProfessions({ role: user.role, professions: user.professions });
  if (professions.includes('manager')) return 'manager';
  if (professions.includes('ex_inspector')) return 'ex_inspector';
  if (professions.includes('technician')) return 'technician';
  if (professions.includes('operative')) return 'operative';
  return 'operative';
}

async function seedLegacyGroupsForTenant({ tenant, features, users, apply }) {
  const tenantId = tenant._id;
  const eligibleUsers = users.filter((user) =>
    String(user.tenantId || '') === String(tenantId) &&
    String(user.role || '') === 'User'
  );
  const byKey = new Map();
  for (const user of eligibleUsers) {
    const key = groupKeyForUser(user);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(user);
  }

  const planned = [];
  for (const [key, members] of byKey.entries()) {
    const name = legacyGroupName(key);
    planned.push({ groupKey: key, name, members: members.map((u) => String(u._id)) });
    if (!apply) continue;

    const permissions = permissionsForLegacyGroup(key);
    await upsertGroupWithMembers({
      tenantId,
      name,
      description: 'Created by tenant RBAC backfill from legacy role/profession access.',
      permissions,
      features: featuresFromPermissions(permissions, features),
      members,
      apply,
    });
  }
  return planned;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const seedDefaultGroups = process.argv.includes('--seed-default-access-groups');
  const seedLegacyGroups = process.argv.includes('--seed-legacy-access-groups');
  const enableGroupRbac = process.argv.includes('--enable-group-rbac');
  await connectDB();

  const tenants = await Tenant.find({}).select('_id name type features professionRbacEnabled').lean();
  const users = seedLegacyGroups || seedDefaultGroups
    ? await User.find({ tenantId: { $ne: null } }).select('_id tenantId role professions email').lean()
    : [];
  const usage = {
    groups: await countsByTenant(TenantAccessGroup),
    customFieldDefinitions: await countsByTenant(CustomFieldDefinition),
    customFieldLayouts: await countsByTenant(FieldLayout, { 'items.source': 'custom' }),
    tenantSchemas: await countsByTenant(SchemaDefinition, { scope: 'tenant' }),
    maintenanceSchemas: await countsByTenant(SchemaDefinition, { scope: 'tenant', type: 'maintenance' }),
    maintenanceEvents: await countsByTenant(MaintenanceEvent),
    maintenanceActivities: await countsByTenant(MaintenanceActivity),
  };

  const changed = [];
  const seededGroups = [];
  let skippedPersonalDefaultGroups = 0;
  for (const [index, tenant] of tenants.entries()) {
    if (apply && (index === 0 || (index + 1) % 25 === 0 || index + 1 === tenants.length)) {
      console.error(`[rbac-backfill] processing tenant ${index + 1}/${tenants.length}: ${tenant.name}`);
    }

    const nextFeatures = inferFeatures(tenant, usage, { enableGroupRbac });
    if (enableGroupRbac && (seedLegacyGroups || seedDefaultGroups) && String(tenant.type || '').toLowerCase() !== 'personal') {
      nextFeatures.groupRbac = true;
    }
    const current = tenant.features || {};
    const needsUpdate = ['maintenance', 'professionRbac', 'groupRbac', 'customFields', 'customSchemas']
      .some((key) => current[key] !== nextFeatures[key]);
    const nextProfessionRbacEnabled = nextFeatures.professionRbac;
    const professionFlagNeedsUpdate = bool(tenant.professionRbacEnabled) !== nextProfessionRbacEnabled;

    if (needsUpdate || professionFlagNeedsUpdate) {
      changed.push({
        tenantId: String(tenant._id),
        name: tenant.name,
        type: tenant.type,
        from: {
          maintenance: current.maintenance,
          professionRbac: current.professionRbac,
          groupRbac: current.groupRbac,
          customFields: current.customFields,
          customSchemas: current.customSchemas,
          professionRbacEnabled: tenant.professionRbacEnabled,
        },
        to: {
          ...nextFeatures,
          professionRbacEnabled: nextProfessionRbacEnabled,
        },
      });

      if (apply) {
        await Tenant.updateOne(
          { _id: tenant._id },
          {
            $set: {
              'features.maintenance': nextFeatures.maintenance,
              'features.professionRbac': nextFeatures.professionRbac,
              'features.groupRbac': nextFeatures.groupRbac,
              'features.customFields': nextFeatures.customFields,
              'features.customSchemas': nextFeatures.customSchemas,
              professionRbacEnabled: nextProfessionRbacEnabled,
            }
          },
          { runValidators: true }
        );
      }
    }

    if (seedDefaultGroups && String(tenant.type || '').toLowerCase() === 'personal') {
      skippedPersonalDefaultGroups += 1;
    }

    if (seedDefaultGroups && String(tenant.type || '').toLowerCase() !== 'personal') {
      const plannedGroups = await seedDefaultGroupsForTenant({
        tenant,
        features: nextFeatures,
        users,
        apply,
      });
      seededGroups.push({
        tenantId: String(tenant._id),
        name: tenant.name,
        seedMode: 'default',
        groups: plannedGroups.map((group) => ({
          groupKey: group.groupKey,
          name: group.name,
          members: group.members.length,
        })),
      });
    }

    if (seedLegacyGroups && String(tenant.type || '').toLowerCase() !== 'personal') {
      const plannedGroups = await seedLegacyGroupsForTenant({
        tenant,
        features: nextFeatures,
        users,
        apply,
      });
      if (plannedGroups.length) {
        seededGroups.push({
          tenantId: String(tenant._id),
          name: tenant.name,
          seedMode: 'legacy',
          groups: plannedGroups.map((group) => ({
            groupKey: group.groupKey,
            name: group.name,
            members: group.members.length,
          })),
        });
      }
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    seedDefaultGroups,
    seedLegacyGroups,
    enableGroupRbac,
    checked: tenants.length,
    skippedPersonalDefaultGroups,
    wouldUpdate: changed.length,
    updated: apply ? changed.length : 0,
    changed,
    seededGroups,
  }, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect failures during fatal script errors
  }
  process.exit(1);
});
