// services/subscriptionSweeper.js
const Subscription = require('../models/subscription');
const Tenant = require('../models/tenant');

let running = false;

async function sweepExpiredSubscriptions() {
  if (running) return;
  running = true;
  const now = new Date();
  const batchSize = Math.min(Math.max(Number(process.env.SUBSCRIPTION_SWEEP_BATCH_SIZE || 500), 50), 2000);
  try {
    // Olyan előfizetések, amelyek már lejártak és nem aktívak.
    const candidates = await Subscription.find({
      expiresAt: { $ne: null, $lt: now },
      status: { $nin: ['active', 'trialing'] }
    })
      .select('tenantId')
      .limit(batchSize)
      .lean();

    const tenantIds = Array.from(new Set((candidates || []).map((c) => c?.tenantId).filter(Boolean).map(String)));
    if (!tenantIds.length) return;

    await Tenant.bulkWrite(
      tenantIds.map((tenantId) => ({
        updateOne: {
          filter: { _id: tenantId },
          update: {
            $set: {
              plan: 'free',
              'seats.max': 1,
              'seats.used': 1,
              seatsManaged: 'manual'
            }
          }
        }
      })),
      { ordered: false }
    );
  } catch (e) {
    console.error('[sweepExpiredSubscriptions] tenant downgrade error', e);
  } finally {
    running = false;
  }
}

module.exports = { sweepExpiredSubscriptions };
