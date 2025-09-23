// middlewares/quotaLimiter.js
// Enforce daily download limits ONLY for Free tenants.
// Pro/Team (active/trialing/past_due and not expired) -> unlimited.
// Admin/SuperAdmin bypass the limit by default.

const DownloadQuota = require('../models/downloadQuota');
const Subscription = require('../models/subscription');
const Tenant = require('../models/tenant');

function todayYMD(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * True if tenant has an active/trialing/past_due Pro/Team subscription (and not expired).
 * Falls back to tenant.plan cache if no subscription doc exists.
 */
async function isPaidTenant(tenantId) {
  if (!tenantId) return false;

  // 1) Check subscription as source-of-truth
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

  // 2) Fallback: tenant "plan" cache (maintained by webhook)
  const t = await Tenant.findById(tenantId).select('plan').lean();
  if (t && (t.plan === 'pro' || t.plan === 'team')) {
    return true;
  }

  return false;
}

/**
 * Napi letöltési limit: FREE = max 3 / nap / user
 * - PRO/TEAM: nincs limit
 * - Admin/SuperAdmin: nincs limit
 */
async function enforceDailyDownloadLimit(req, res, next) {
  try {
    const user = req.user || {};
    const role = (user.role || '').toString();
    const userId = user.id || user.userId || req.userId || null;
    const tenantId = user.tenantId || req.scope?.tenantId || null;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Admins bypass
    if (role === 'Admin' || role === 'SuperAdmin') {
      return next();
    }

    // Paid tenants bypass
    if (await isPaidTenant(tenantId)) {
      return next();
    }

    // FREE → limit 3 / nap
    const ymd = todayYMD();
    const doc = await DownloadQuota.findOne({ userId, ymd }).lean();
    const count = doc?.count || 0;
    const LIMIT = 3;

    if (count >= LIMIT) {
      return res.status(429).json({
        error: 'Daily download limit reached for Free plan.',
        details: { limit: LIMIT, remaining: 0 }
      });
    }

    // pass through; increment happens on successful SAS generation
    return next();
  } catch (e) {
    console.error('[quota] enforceDailyDownloadLimit error', e);
    // Fail-open: do not block downloads if quota check errored.
    return next();
  }
}

/**
 * Inkrementálás sikeres SAS kiadása után.
 * Idempotens annyiban, hogy nap+user kulcson upsertelünk és +1
 */
async function incrementDailyDownload(req, _res, next) {
  try {
    const user = req.user || {};
    const userId = user.id || user.userId || req.userId || null;
    const tenantId = user.tenantId || req.scope?.tenantId || null;

    if (!userId) return next();

    // Do not count for paid tenants
    if (await isPaidTenant(tenantId)) {
      return next();
    }

    const ymd = todayYMD();
    await DownloadQuota.updateOne(
      { userId, ymd },
      { $inc: { count: 1 } },
      { upsert: true }
    );

    return next();
  } catch (e) {
    // Do not block download if increment fails
    try { console.warn('[quota] incrementDailyDownload failed', e?.message || e); } catch {}
    return next();
  }
}

module.exports = {
  enforceDailyDownloadLimit,
  incrementDailyDownload,
};