require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Tenant = require('../models/tenant');
const User = require('../models/user');
const TenantAccessGroup = require('../models/tenantAccessGroup');
const TenantAccessGroupMembership = require('../models/tenantAccessGroupMembership');

const DEFAULT_PASSWORD = 'tesz100';
const CRUD_ACTIONS = ['read', 'create', 'update', 'delete'];
const ALL_RESOURCES = ['site', 'zone', 'equipment', 'inspection', 'maintenance', 'customField', 'customSchema', 'manufacturer', 'dashboard', 'user'];
const POWERUSER_RESOURCES = ['site', 'zone', 'equipment', 'inspection', 'maintenance', 'customField', 'customSchema', 'manufacturer'];

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name, fallback) {
  const n = Number(argValue(name, ''));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildTenantName(prefix, index) {
  return slug(`${prefix}-${String(index).padStart(2, '0')}`);
}

function buildEmail(domain, tenantIndex, userPart) {
  return `rbac.t${String(tenantIndex).padStart(2, '0')}.${userPart}@${domain}`.toLowerCase();
}

function featureDefaults() {
  return {
    maintenance: true,
    professionRbac: false,
    groupRbac: true,
    customFields: true,
    customSchemas: true,
  };
}

function permissionsForGroup(name) {
  if (name === 'Admin') {
    return ALL_RESOURCES.map((resource) => ({ resource, actions: [...CRUD_ACTIONS] }));
  }
  return [
    ...POWERUSER_RESOURCES.map((resource) => ({ resource, actions: [...CRUD_ACTIONS] })),
    { resource: 'dashboard', actions: ['read'] },
  ];
}

function featuresFromPermissions(permissions) {
  const hasActions = (resource) => {
    const row = permissions.find((perm) => perm.resource === resource);
    return Array.isArray(row?.actions) && row.actions.length > 0;
  };
  return {
    maintenance: hasActions('maintenance'),
    professionRbac: hasActions('user'),
    groupRbac: hasActions('user'),
    customFields: hasActions('customField'),
    customSchemas: hasActions('customSchema'),
  };
}

async function upsertTenant({ name, dryRun }) {
  const existing = await Tenant.findOne({ name });
  if (existing) {
    if (dryRun) return { tenant: existing, action: 'exists' };
    existing.type = 'company';
    existing.plan = 'team';
    existing.seats = { max: Math.max(existing.seats?.max || 0, 10), used: existing.seats?.used || 0 };
    existing.seatsManaged = 'manual';
    existing.features = featureDefaults();
    existing.professionRbacEnabled = false;
    await existing.save();
    return { tenant: existing, action: 'updated' };
  }

  const tenant = new Tenant({
    name,
    type: 'company',
    plan: 'team',
    seats: { max: 10, used: 0 },
    seatsManaged: 'manual',
    features: featureDefaults(),
    professionRbacEnabled: false,
  });
  if (!dryRun) await tenant.save();
  return { tenant, action: 'created' };
}

async function upsertUser({ tenant, email, firstName, lastName, role, dryRun }) {
  const existing = await User.findOne({ email });
  if (existing) {
    if (dryRun) return { user: existing, action: 'exists' };
    existing.firstName = firstName;
    existing.lastName = lastName;
    existing.nickname = firstName;
    existing.role = role;
    existing.tenantId = tenant._id;
    existing.password = DEFAULT_PASSWORD;
    existing.emailVerified = true;
    existing.professions = undefined;
    await existing.save();
    return { user: existing, action: 'updated' };
  }

  const user = new User({
    firstName,
    lastName,
    nickname: firstName,
    email,
    password: DEFAULT_PASSWORD,
    role,
    tenantId: tenant._id,
    emailVerified: true,
  });
  if (!dryRun) await user.save();
  return { user, action: 'created' };
}

async function upsertAccessGroup({ tenant, name, members, dryRun }) {
  const permissions = permissionsForGroup(name);
  const existing = tenant._id ? await TenantAccessGroup.findOne({ tenantId: tenant._id, name }) : null;
  if (dryRun) {
    return {
      name,
      action: existing ? 'exists' : 'created',
      members: members.map((u) => u.email),
    };
  }

  const group = await TenantAccessGroup.findOneAndUpdate(
    { tenantId: tenant._id, name },
    {
      $setOnInsert: {
        tenantId: tenant._id,
        name,
        description: `Dummy ${name} group for RBAC testing.`,
      },
      $set: {
        active: true,
        permissions,
        features: featuresFromPermissions(permissions),
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

  for (const member of members) {
    await TenantAccessGroupMembership.updateOne(
      { tenantId: tenant._id, groupId: group._id, userId: member._id },
      { $setOnInsert: { tenantId: tenant._id, groupId: group._id, userId: member._id } },
      { upsert: true }
    );
  }

  return {
    name,
    action: existing ? 'updated' : 'created',
    members: members.map((u) => u.email),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;
  const tenantCount = intArg('--tenants', 3);
  const usersPerTenant = intArg('--users-per-tenant', 3);
  const prefix = slug(argValue('--prefix', 'rbac-demo')) || 'rbac-demo';
  const domain = String(argValue('--domain', 'example.test')).trim().toLowerCase();

  await connectDB();

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    password: DEFAULT_PASSWORD,
    tenantCount,
    usersPerTenant,
    tenants: [],
  };

  for (let i = 1; i <= tenantCount; i += 1) {
    const name = buildTenantName(prefix, i);
    const { tenant, action: tenantAction } = await upsertTenant({ name, dryRun });
    const adminEmail = buildEmail(domain, i, 'admin');
    const admin = await upsertUser({
      tenant,
      email: adminEmail,
      firstName: `Demo${i}`,
      lastName: 'Admin',
      role: 'Admin',
      dryRun,
    });

    const users = [];
    for (let u = 1; u <= usersPerTenant; u += 1) {
      const userEmail = buildEmail(domain, i, `user${u}`);
      users.push(await upsertUser({
        tenant,
        email: userEmail,
        firstName: `Demo${i}`,
        lastName: `User${u}`,
        role: 'User',
        dryRun,
      }));
    }

    const groups = await Promise.all([
      upsertAccessGroup({ tenant, name: 'Admin', members: [admin.user], dryRun }),
      upsertAccessGroup({ tenant, name: 'PowerUser', members: users.map((row) => row.user), dryRun }),
    ]);

    if (!dryRun && admin.user?._id && (!tenant.ownerUserId || String(tenant.ownerUserId) !== String(admin.user._id))) {
      tenant.ownerUserId = admin.user._id;
      tenant.seats = { max: Math.max(tenant.seats?.max || 0, usersPerTenant + 1), used: usersPerTenant + 1 };
      await tenant.save();
    }

    report.tenants.push({
      name,
      tenantAction,
      admin: { email: adminEmail, action: admin.action },
      users: users.map((row) => ({
        email: row.user.email,
        action: row.action,
      })),
      groups,
    });
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
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
