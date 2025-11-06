// controllers/userController.js
const User = require('../models/user');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const DownloadQuota = require('../models/downloadQuota');
const Subscription = require('../models/subscription');
const SubscriptionModel = Subscription; // alias for clarity if needed elsewhere
const Tenant = require('../models/tenant');

const mailService = require('../services/mailService');
const { tenantInviteEmailHtml } = require('../services/mailTemplates');
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
      // Add: public certificate contribution count per user
      {
        $lookup: {
          from: 'certificates',
          let: { uid: '$_id' },
          pipeline: [
            { $addFields: { _createdByStr: { $toString: '$createdBy' }, _vis: { $toLower: '$visibility' } } },
            { $match: { $expr: { $and: [
              { $eq: ['$_createdByStr', { $toString: '$$uid' }] },
              { $eq: ['$_vis', 'public'] }
            ] } } },
            { $count: 'count' }
          ],
          as: 'publicContributionAgg'
        }
      },
      { $addFields: { publicContributionCount: { $ifNull: [ { $arrayElemAt: ['$publicContributionAgg.count', 0] }, 0 ] } } },
      { $unset: 'publicContributionAgg' },
      // Add: pending drafts count per user (statuses: draft, ready, error), robust id matching
      {
        $lookup: {
          from: 'draftcertificates',
          let: { uid: '$_id', tId: '$tenantId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: [ { $toString: '$createdBy' }, { $toString: '$$uid' } ] },
                    { $eq: [ { $toString: '$tenantId' }, { $toString: '$$tId' } ] },
                    { $in: [ '$status', ['draft', 'ready', 'error'] ] }
                  ]
                }
              }
            },
            { $count: 'count' }
          ],
          as: 'pendingAgg'
        }
      },
      { $addFields: { pendingCount: { $ifNull: [ { $arrayElemAt: ['$pendingAgg.count', 0] }, 0 ] } } },
      { $unset: 'pendingAgg' },
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
          subscriptionExpiresAt: '$subscription.expiresAt',
          publicContributionCount: 1,
          pendingCount: 1
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

    const toTenant = await Tenant.findById(toTenantId).select('seats name').lean();
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

    // --- fire-and-forget tenant-added e-mail ---
    (async () => {
      try {
        const appBase = process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
        const html = tenantInviteEmailHtml({
          firstName: user.firstName || '',
          lastName:  user.lastName  || '',
          tenantName: (toTenant && toTenant.name) || 'your organization',
          loginUrl: appBase,
          password: req.body?.generatedPassword || user._tempGeneratedPassword || null,
        });
        await mailService.sendMail({
          to: user.email,
          subject: `You have been added to ${(toTenant && toTenant.name) || 'ATEXdb Certs'}`,
          html,
          from: process.env.MAIL_SENDER_UPN, // app-perm küldő (UPN/GUID)
        });
        console.log('[mail] Tenant-added email sent to', user.email);
      } catch (err) {
        console.warn('[mail] Tenant-added e-mail failed:', err?.message || err);
      }
    })();

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
/*exports.register = async (req, res) => {
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

    // Fire-and-forget welcome e-mail (do not block registration flow)
    (async () => {
      try {
        const loginUrl = process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
        const html = registrationEmailHtml({
          firstName: user.firstName || '',
          lastName:  user.lastName  || '',
          loginUrl
        });
        await mailService.sendMail({
          to: user.email,
          subject: 'Welcome to ATEXdb Certs',
          html,
          from: process.env.MAIL_SENDER_UPN
        });
        console.log('[mail] Registration welcome email sent to', user.email);
      } catch (err) {
        console.warn('[mail] Registration e-mail failed:', err?.message || err);
      }
    })();

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
}; */

const jwt = require('jsonwebtoken');

// Helper: egyszerű slugify + ensure unique tenant name (local)
async function makeUniqueTenantName(base) {
  const raw = String(base || `tenant-${Math.random().toString(36).slice(2,8)}`).trim();
  const slug = () => raw.toLowerCase().replace(/[^a-z0-9\-_.]+/g, '-').replace(/^-+|-+$/g, '').substring(0,64);
  let candidate = slug();
  let i = 1;
  while (await Tenant.findOne({ name: candidate })) {
    i += 1;
    candidate = (slug().substring(0, 56) + '-' + i).substring(0,64);
  }
  return candidate;
}

/**
 * POST /api/admin/create-paid-tenant-user
 * Body: { email, firstName?, lastName?, password?, tenantName?, plan?: 'pro'|'team', seats?: number, role?: 'User'|'Admin' }
 * Guard: authMiddleware(['Admin','SuperAdmin']) — csak Admin / SuperAdmin hívja
 */
exports.createPaidTenantUser = async (req, res) => {
  try {
    const callerRole = (req.role || '').toString();
    if (!['Admin','SuperAdmin'].includes(callerRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const {
      email,
      firstName = '',
      lastName = '',
      password = null,
      tenantName = null,
      plan = 'pro',   // 'pro' vagy 'team'
      seats = (plan === 'team' ? 5 : 1),
      role = 'User'
    } = req.body || {};

    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!['pro','team'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    if (plan === 'team' && (!Number.isInteger(seats) || seats < 5)) {
      return res.status(400).json({ error: 'Team plan needs at least 5 seats' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ error: 'User already exists' });

    // 1) Tenant létrehozása (manual seats management)
    const tenantUniqueName = await makeUniqueTenantName(tenantName || (plan === 'team' ? 'company' : `u-${normalizedEmail.split('@')[0]}`));
    const tenant = await Tenant.create({
      name: tenantUniqueName,
      type: plan === 'team' ? 'company' : 'personal',
      plan: plan,
      ownerUserId: undefined,
      seats: { max: seats, used: 1 },
      seatsManaged: 'manual', // fontos: stripe nélkül manuális kezelés
    });

    // 2) User létrehozása
    const pwd = password || Math.random().toString(36).slice(2,10) + 'A1'; // ha nincs pw: ideiglenes
    const hashed = await bcrypt.hash(String(pwd), 10);

    const user = await User.create({
      firstName,
      lastName,
      email: normalizedEmail,
      password: hashed,
      role: plan === 'team' ? 'Admin' : role,
      tenantId: tenant._id,
      nickname: firstName || normalizedEmail.split('@')[0]
    });
    await Tenant.findByIdAndUpdate(tenant._id, { ownerUserId: user._id });

    // 3) Subscription dokument létrehozása (manuálisan, active)
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1); // 1 év
    const sub = await Subscription.create({
      tenantId: tenant._id,
      tier: plan,                 // 'pro' | 'team'
      status: 'active',
      seatsPurchased: seats,
      expiresAt: expires,
      // egyéb mezők: customerId / stripeSubscriptionId --> üresen hagyjuk
    });

    // 4) (Biztonsági) tenant cache/frissítés: állítsuk be a tenant.plan is ha szükséges
    await Tenant.findByIdAndUpdate(tenant._id, { plan, 'seats.used': 1, seatsManaged: 'manual' });

    // 5) Token generálás (rövid életű access token)
    // A payload tükrözi a signAccessTokenWithSubscription logikáját:
    const payload = {
      sub: String(user._id),
      userId: String(user._id),
      role: user.role,
      tenantId: String(tenant._id),
      tenantName: tenant.name,
      tenantType: tenant.type,
      nickname: user.nickname || null,
      firstName: user.firstName,
      lastName: user.lastName,
      azureId: user.azureId || null,
      subscription: {
        tenantName: tenant.name,
        tenantType: tenant.type,
        plan: tenant.plan,
        seats: { max: tenant.seats.max, used: tenant.seats.used },
        seatsManaged: tenant.seatsManaged,
        tier: sub.tier,
        status: sub.status,
        seatsPurchased: sub.seatsPurchased,
        lastUpdate: sub.updatedAt || sub.createdAt || null,
        flags: {
          isFree: sub.tier === 'free',
          isPro: sub.tier === 'pro',
          isTeam: sub.tier === 'team',
        }
      },
      type: 'access',
      v: 2,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

    // 6) (Opcionális) e-mail küldés: tenantInviteEmailHtml használatával (fire-and-forget)
    (async () => {
      try {
        const html = tenantInviteEmailHtml({
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          tenantName: tenant.name,
          loginUrl: process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu',
          password: pwd
        });
        await mailService.sendMail({
          to: user.email,
          subject: `You're added to ${tenant.name}`,
          html,
          from: process.env.MAIL_SENDER_UPN
        });
      } catch (err) {
        console.warn('[mail] tenant invite mail failed', err?.message || err);
      }
    })();

    return res.status(201).json({
      message: 'Paid tenant + user created (manual).',
      user: { id: user._id, email: user.email, tenantId: tenant._id, role: user.role },
      tenant: { id: tenant._id, name: tenant.name, plan: tenant.plan, seats: tenant.seats },
      subscription: { id: sub._id, tier: sub.tier, status: sub.status, expiresAt: sub.expiresAt },
      token
    });

  } catch (e) {
    console.error('createPaidTenantUser error', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
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
