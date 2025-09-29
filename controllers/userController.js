// controllers/userController.js
const User = require('../models/user');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const DownloadQuota = require('../models/downloadQuota');
const Subscription = require('../models/subscription');
const SubscriptionModel = Subscription; // alias for clarity if needed elsewhere
const Tenant = require('../models/tenant');
const { migrateAllUserDataToTenant } = require('../services/tenantMigration');

// --- Daily download quota (Free plan) helpers ---
const FREE_DAILY_LIMIT = 3;

function todayYMD(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Local check to determine if tenant is paid (Pro/Team and not expired)
async function isPaidTenantLocal(tenantId) {
  if (!tenantId) return false;

  // 1) Source of truth: Subscription doc
  const sub = await Subscription.findOne({
    tenantId,
    status: { $in: ['active', 'trialing', 'past_due'] }
  }).lean();

  if (sub && (sub.tier === 'pro' || sub.tier === 'team')) {
    // if there is a hard expiry, ensure it's not in the past
    if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
      return false;
    }
    return true;
  }

  // 2) Fallback: tenant.plan cache (maintained by webhook)
  const t = await Tenant.findById(tenantId).select('plan').lean();
  if (t && (t.plan === 'pro' || t.plan === 'team')) {
    return true;
  }
  return false;
}

// Get User Profile
exports.getUserProfile = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const role = req.role;

    let query;
    if (role === 'SuperAdmin') {
      query = { _id: req.params.userId };
    } else {
      if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });
      query = { _id: req.params.userId, tenantId };
    }

    const user = await User.findOne(query).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------
// Delete User (Admin/SuperAdmin)
// DELETE /api/users/:userId
// - Admin: csak a saját tenantjából törölhet
// - SuperAdmin: bárkit törölhet
// - Seats: ha volt tenant, seats.used -- (min 0-ig)
// Megjegyzés: tranzakció helyett best-effort, hogy standalone MongoDB-n is működjön
// ---------------------------
exports.deleteUser = async (req, res) => {
  const role = (req.role || '').toString();
  const callerTenantId = req.scope?.tenantId || null;
  const { userId } = req.params || {};

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Cross-tenant védelem Admin esetén
    if (role !== 'SuperAdmin' && String(user.tenantId || '') !== String(callerTenantId || '')) {
      return res.status(403).json({ error: 'Forbidden: cannot delete user from another tenant' });
    }

    // Admin nem törölhet SuperAdmint
    if (user.role === 'SuperAdmin' && role !== 'SuperAdmin') {
      return res.status(403).json({ error: 'Forbidden: cannot delete a SuperAdmin' });
    }

    const tenantId = user.tenantId ? String(user.tenantId) : null;

    // Törlés (best-effort)
    const del = await User.deleteOne({ _id: userId });
    if (!del?.acknowledged) {
      return res.status(500).json({ error: 'Failed to delete user (not acknowledged)' });
    }
    if (del.deletedCount === 0) {
      return res.status(404).json({ error: 'User not found (already deleted)' });
    }

    // Seats used -- ha volt tenant (race-safe feltétellel, min 0-ig)
    if (tenantId) {
      await Tenant.updateOne(
        { _id: tenantId, 'seats.used': { $gt: 0 } },
        { $inc: { 'seats.used': -1 } }
      );

      // EXTRA: ha a tenant 'personal' és árva/owner volt a törölt user → töröljük a tenantot is
      try {
        const t = await Tenant.findById(tenantId).select('_id type ownerUserId').lean();
        if (t && t.type === 'personal') {
          const remaining = await User.countDocuments({ tenantId });
          const ownedByDeleted = t.ownerUserId && String(t.ownerUserId) === String(userId);
          if (ownedByDeleted || remaining === 0) {
            await Tenant.deleteOne({ _id: tenantId });
          }
        }
      } catch (_) {
        // swallow – a felhasználó törlését ne blokkolja
      }
    }

    return res.json({ message: 'User deleted.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to delete user' });
  }
};

// ---------------------------
// List Users (search/sort/paginate)
// GET /api/users?search=&page=1&limit=10&sortBy=firstName&sortDir=asc
// Roles: SuperAdmin -> all tenants; Admin -> only same tenant; User -> forbidden
// Returns: { items: [{ id, firstName, lastName, email, tenantName, azureId }], total, page, limit }
// ---------------------------
exports.listUsers = async (req, res) => {
  try {
    const role = (req.role || '').toString();
    const tenantId = req.scope?.tenantId || null;

    if (!['Admin', 'SuperAdmin'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Csak tenant-scope (SuperAdmin: nincs korlátozás; Admin: csak saját tenant)
    const preLookupMatch = {};
    if (role !== 'SuperAdmin') {
      if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });
      preLookupMatch.tenantId = new mongoose.Types.ObjectId(String(tenantId));
    }

    const pipeline = [];
    if (Object.keys(preLookupMatch).length > 0) {
      pipeline.push({ $match: preLookupMatch });
    }

    pipeline.push(
      { $lookup: { from: 'tenants', localField: 'tenantId', foreignField: '_id', as: 'tenant' } },
      { $unwind: { path: '$tenant', preserveNullAndEmptyArrays: true } },
      // Subscription snapshot (latest by updatedAt) for the user's tenant
      {
        $lookup: {
          from: 'subscriptions',
          let: { tId: '$tenantId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$tenantId', '$$tId'] } } },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, tier: 1, status: 1, expiresAt: 1 } }
          ],
          as: 'subscription'
        }
      },
      { $unwind: { path: '$subscription', preserveNullAndEmptyArrays: true } },
      // Stabil, determinisztikus sorrend (kliens oldali szűrés/rendezés/lapozás lesz)
      { $sort: { firstName: 1, _id: 1 } },
      {
        $project: {
          _id: 0,
          id: '$_id',
          firstName: 1,
          lastName: 1,
          email: 1,
          azureId: 1,
          tenantId: 1,
          tenantName: '$tenant.name',
          tenantPlan: '$tenant.plan',
          subscriptionTier: '$subscription.tier',
          subscriptionStatus: '$subscription.status',
          subscriptionExpiresAt: '$subscription.expiresAt'
        }
      }
    );

    const rows = await User.aggregate(pipeline);

    return res.json({
      items: rows,
      total: rows.length
    });
  } catch (error) {
    console.error('listUsers error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------
// Admin move user to tenant (seat-safe, transactional)
// POST /api/admin/tenants/:toTenantId/move-user
// Body: { userId }
// Guard: Admin (csak saját tenantba mozgathat), SuperAdmin (bárhova)
// ---------------------------
// ---------------------------
// Admin move user to tenant (seat-safe, non-transactional)
// POST /api/admin/tenants/:toTenantId/move-user
// Body: { userId }
// Guard: Admin (csak saját tenantba mozgathat), SuperAdmin (bárhova)
// ---------------------------
exports.moveUserToTenant = async (req, res) => {
  const role = (req.role || '').toString();
  const callerTenantId = req.scope?.tenantId || null;
  const { toTenantId } = req.params;
  const { userId } = req.body || {};

  if (!userId || !toTenantId) {
    return res.status(400).json({ error: 'userId és toTenantId kötelező.' });
  }

  // Admin csak a SAJÁT tenantjába mozgathat
  if (role !== 'SuperAdmin' && String(callerTenantId) !== String(toTenantId)) {
    return res.status(403).json({ error: 'Admin csak a saját tenantjába mozgathat felhasználót.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User nem található.' });

    const fromTenantId = user.tenantId ? String(user.tenantId) : null;
    if (String(user.tenantId) === String(toTenantId)) {
      return res.json({ message: 'User már a cél tenantban van. Nincs teendő.' });
    }

    const toTenant = await Tenant.findById(toTenantId).select('seats').lean();
    if (!toTenant) return res.status(404).json({ error: 'Cél tenant nem található.' });

    // Seat ellenőrzés + atomikus foglalás feltétellel
    const seatInc = await Tenant.updateOne(
      { _id: toTenantId, 'seats.used': { $lt: toTenant.seats.max } },
      { $inc: { 'seats.used': 1 } }
    );
    if (!seatInc?.acknowledged || seatInc.modifiedCount !== 1) {
      return res.status(400).json({ error: 'Nincs szabad seat a cél tenantban.' });
    }

    // Migráció a user korábbi tenantjáról az újra (best-effort)
    if (fromTenantId) {
      try { await migrateAllUserDataToTenant(fromTenantId, toTenantId); } catch (_) {}
    }

    // User áthelyezés (szerepkört nem írjuk felül itt)
    user.tenantId = toTenantId;
    await user.save();

    // Forrás tenant used-- (ha volt) – feltételes, hogy ne menjen 0 alá
    if (fromTenantId) {
      await Tenant.updateOne(
        { _id: fromTenantId, 'seats.used': { $gt: 0 } },
        { $inc: { 'seats.used': -1 } }
      );
    }

    return res.json({ message: '✅ Felhasználó áthelyezve a cél tenantba.' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};

// Update User Profile
exports.updateUserProfile = async (req, res) => {
  const { firstName, lastName, nickname, billingName, billingAddress } = req.body;

  try {
    const tenantId = req.scope?.tenantId;
    const role = req.role;

    let query;
    if (role === 'SuperAdmin') {
      query = { _id: req.params.userId };
    } else {
      if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });
      query = { _id: req.params.userId, tenantId };
    }

    const user = await User.findOneAndUpdate(
      query,
      { firstName, lastName, nickname, billingName, billingAddress },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------
// Registration + Tenant utils
// ---------------------------

// Slugify tenant name (lowercase, alnum + dash)
function slugifyTenantName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 48) || `tenant-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureUniqueTenantName(base) {
  let candidate = slugifyTenantName(base);
  let i = 1;
  while (await Tenant.findOne({ name: candidate })) {
    i += 1;
    candidate = `${slugifyTenantName(base)}-${i}`;
  }
  return candidate;
}

/**
 * Create a tenant for registration flows.
 * plan: 'free'|'pro'|'team'
 * - free/pro -> type='personal'
 * - team     -> type='company', seats.max=5 by default, user becomes Admin
 */
async function createTenantForRegistration({ plan, companyName, ownerUserId }) {
  const isTeam = String(plan).toLowerCase() === 'team';
  const type = isTeam ? 'company' : 'personal';
  const nameSource = isTeam ? (companyName || 'company') : `u-${ownerUserId || Math.random().toString(36).slice(2,6)}`;
  const uniqueName = await ensureUniqueTenantName(nameSource);

  const tenant = new Tenant({
    name: uniqueName,
    type,
    plan: String(plan).toLowerCase(), // 'free' | 'pro' | 'team'
    ownerUserId: ownerUserId ? new mongoose.Types.ObjectId(ownerUserId) : undefined,
    seats: isTeam ? { max: 5, used: 1 } : { max: 1, used: 1 },
  });

  await tenant.save();
  return tenant;
}

// ---------------------------
// POST /api/register
// Body: { email, password, firstName?, lastName?, nickname?, plan:'free'|'pro'|'team', companyName? }
// Behavior:
//  - Validates and ensures unique email
//  - Creates user
//  - Creates tenant depending on plan
//  - Links user to tenant (team -> user.role='Admin')
//  - Does NOT start Stripe automatically (frontend can call a billing endpoint after)
//  - Returns minimal safe payload
// ---------------------------
exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      nickname,
      plan = 'free',
      companyName,
    } = req.body || {};

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: 'Email already in use.' });
    }

    const hash = await bcrypt.hash(String(password), 10);

    // Create bare user first (tenant will be attached after createTenantForRegistration)
    const user = new User({
      email: normalizedEmail,
      password: hash,
      firstName: firstName || '',
      lastName: lastName || '',
      nickname: nickname || firstName || '',
      role: 'User',                 // default; may be upgraded to Admin for TEAM
      subscriptionTier: String(plan).toLowerCase(), // 'free' | 'pro' | 'team'
    });

    await user.save();

    // Create tenant based on plan
    const tenant = await createTenantForRegistration({
      plan,
      companyName,
      ownerUserId: user._id,
    });

    // Link user to tenant; for TEAM owner is Admin
    user.tenantId = tenant._id;
    if (String(plan).toLowerCase() === 'team') {
      user.role = 'Admin';
    }
    await user.save();

    // NOTE: Stripe: frontend should now open a checkout session for pro/team.
    // We intentionally do not start Stripe here to keep controller cohesive.
    // Return minimal info so frontend can proceed to billing if needed.
    return res.status(201).json({
      message: 'Registration successful.',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        nickname: user.nickname,
        role: user.role,
        subscriptionTier: user.subscriptionTier,
        tenantId: tenant._id,
      },
      tenant: {
        id: tenant._id,
        name: tenant.name,
        type: tenant.type,
        plan: tenant.plan,
        seats: tenant.seats,
      }
    });
  } catch (error) {
    console.error('register error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------
// POST /api/register/tenant-only
// Body: { plan:'free'|'pro'|'team', companyName? }
// Requires auth (uses req.scope?.userId) to create an extra tenant and attach caller as owner.
// Useful for later flows; optional for your current needs.
// ---------------------------
exports.createTenant = async (req, res) => {
  try {
    const userId = req.scope?.userId || req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { plan = 'free', companyName } = req.body || {};
    const tenant = await createTenantForRegistration({
      plan,
      companyName,
      ownerUserId: userId,
    });

    return res.status(201).json({
      message: 'Tenant created.',
      tenant: {
        id: tenant._id,
        name: tenant.name,
        type: tenant.type,
        plan: tenant.plan,
        seats: tenant.seats,
      }
    });
  } catch (error) {
    console.error('createTenant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------------------------
// GET /api/users/me/quota
// Returns today's remaining download quota (e.g., Free users: 3/day)
// ---------------------------
exports.getMyDownloadQuota = async (req, res) => {
  try {
    const user = req.user || {};
    const role = String(user.role || '');
    const userId = user.id || user.userId || req.scope?.userId || req.user?.id || null;
    const tenantId = user.tenantId || req.scope?.tenantId || null;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Admins: unlimited
    if (role === 'Admin' || role === 'SuperAdmin') {
      return res.json({
        plan: 'admin',
        unlimited: true,
        limit: null,
        remaining: null,
      });
    }

    // Paid tenant (Pro/Team and not expired): unlimited
    if (await isPaidTenantLocal(tenantId)) {
      return res.json({
        plan: 'paid',
        unlimited: true,
        limit: null,
        remaining: null,
      });
    }

    // Free plan: enforce daily limit
    const ymd = todayYMD();
    const doc = await DownloadQuota.findOne({ userId, ymd }).lean();
    const used = doc?.count || 0;
    const remaining = Math.max(0, FREE_DAILY_LIMIT - used);

    return res.json({
      plan: 'free',
      unlimited: false,
      limit: FREE_DAILY_LIMIT,
      remaining,
    });
  } catch (err) {
    console.error('getMyDownloadQuota error', err);
    return res.status(500).json({ error: 'Failed to fetch quota' });
  }
};
