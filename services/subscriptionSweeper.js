// services/subscriptionSweeper.js
const Subscription = require('../models/subscription');
const Tenant = require('../models/tenant');

async function sweepExpiredSubscriptions() {
  const now = new Date();
  // Olyan előfizetések, amelyek már lejártak (period_end < now) és nem aktívak
  const candidates = await Subscription.find({
    currentPeriodEnd: { $ne: null, $lt: now },
    status: { $nin: ['active', 'trialing'] }
  }).select('tenantId').lean();

  for (const c of candidates) {
    try {
      // downgrade tenant to free (cache)
      await Tenant.findByIdAndUpdate(
        c.tenantId,
        {
          $set: {
            plan: 'free',
            'seats.max': 1,
            'seats.used': 1,
            seatsManaged: 'manual'
          }
        }
      );
    } catch (e) {
      console.error('[sweepExpiredSubscriptions] tenant downgrade error', e);
    }
  }
}

module.exports = { sweepExpiredSubscriptions };