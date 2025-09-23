// middlewares/subscriptionGuards.js
const Subscription = require('../models/subscription');

function isActiveStatus(s) {
  const v = String(s || '').toLowerCase();
  return v === 'active' || v === 'trialing';
}

function isActiveNow(sub) {
  if (!sub) return false;
  const now = Date.now();
  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : null;
  // Akkor aktív, ha a státusz aktív jellegű és még NEM múlt el a period vége
  return isActiveStatus(sub.status) && (!end || now <= end);
}

exports.requireActiveSubscription = () => {
  return async (req, res, next) => {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(403).json({ message: 'Missing tenant' });
    const sub = await Subscription.findOne({ tenantId }).lean();
    if (isActiveNow(sub)) return next();
    return res.status(402).json({ message: 'Subscription inactive' }); // Payment Required
  };
};