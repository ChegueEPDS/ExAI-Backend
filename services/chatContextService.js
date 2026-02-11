const Subscription = require('../models/subscription');
const Tenant = require('../models/tenant');

async function resolveUserPlan(req, tenantId, logger) {
  // 1) Try req.auth.subscription?.plan (auth controller attaches subscription snapshot)
  // 2) Fallbacks to req.user.subscription?.tier, req.user.plan, req.auth.subscription?.tier, req.auth.plan, req.scope.plan
  // 3) Final fallback: query DB (Subscription / Tenant) by tenantId
  let userPlan =
    (req.auth && req.auth.subscription?.plan) ||
    (req.user && (req.user.subscription?.tier || req.user.plan)) ||
    (req.auth && (req.auth.subscription?.tier || req.auth.plan)) ||
    (req.scope && req.scope.plan) ||
    null;

  if (!userPlan) {
    try {
      const subDoc = await Subscription.findOne({ tenantId }).select('tier');
      const tenDoc = await Tenant.findById(tenantId).select('plan');
      userPlan = (subDoc?.tier || tenDoc?.plan || 'unknown');
      if (userPlan !== 'unknown') {
        try { logger?.info?.(`[STREAM] Plan resolved via DB fallback: plan=${userPlan}`); } catch { }
      }
    } catch (e) {
      userPlan = 'unknown';
      try { logger?.warn?.('[STREAM] Failed to resolve plan from DB fallback:', e?.message); } catch { }
    }
  }

  return userPlan || 'unknown';
}

module.exports = { resolveUserPlan };
