const Documentation = require('../models/documentation');
const DocumentationExpiryNotification = require('../models/documentationExpiryNotification');
const Tenant = require('../models/tenant');
const { isFeatureEnabled } = require('../middlewares/tenantFeatureMiddleware');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { usersWhoCanUpdateDocumentation } = require('./documentationService');

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLDS = [90, 60, 30, 0];

function thresholdFor(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return null;
  const daysRemaining = Math.ceil((exp.getTime() - now.getTime()) / DAY_MS);
  if (daysRemaining <= 0) return 0;
  for (const threshold of THRESHOLDS) {
    if (threshold > 0 && daysRemaining <= threshold) return threshold;
  }
  return null;
}

function buildMessage(doc, threshold) {
  const title = threshold === 0 ? 'Documentation expired' : `Documentation expires in ${threshold} days`;
  const date = doc.expiresAt ? new Date(doc.expiresAt).toISOString().slice(0, 10) : '';
  const name = doc.alias || doc.name || 'Documentation';
  const message = threshold === 0
    ? `${name} expired on ${date}.`
    : `${name} expires on ${date}.`;
  return { title, message };
}

async function notifyDoc(doc, threshold) {
  const users = await usersWhoCanUpdateDocumentation(doc.tenantId);
  if (!users.length) return { notified: 0 };

  let notified = 0;
  for (const user of users) {
    try {
      await DocumentationExpiryNotification.create({
        tenantId: doc.tenantId,
        documentationId: doc._id,
        thresholdDays: threshold,
        userId: user._id,
      });
    } catch (e) {
      if (e?.code === 11000) continue;
      throw e;
    }

    const { title, message } = buildMessage(doc, threshold);
    await notifyAndStore(String(user._id), {
      type: 'documentation-expiry',
      title,
      message,
      data: {
        jobId: `documentation-expiry:${doc._id}:${threshold}`,
        documentationId: String(doc._id),
        thresholdDays: threshold,
        expiresAt: doc.expiresAt,
      },
      meta: { route: '/documentations' },
      idempotencyKey: `documentation-expiry:${doc._id}:${threshold}:${user._id}`,
    });
    notified += 1;
  }
  return { notified };
}

async function sweepDocumentationExpiryNotifications() {
  const now = new Date();
  const maxDate = new Date(now.getTime() + 90 * DAY_MS);
  const docs = await Documentation.find({
    expiresAt: { $ne: null, $lte: maxDate },
  }).select('_id tenantId name alias expiresAt').lean();

  let checked = 0;
  let notified = 0;
  const tenantFeatureCache = new Map();
  for (const doc of docs) {
    const tenantKey = String(doc.tenantId || '');
    if (!tenantFeatureCache.has(tenantKey)) {
      const tenant = await Tenant.findById(doc.tenantId).select('type features').lean();
      tenantFeatureCache.set(tenantKey, isFeatureEnabled(tenant, 'documentation'));
    }
    if (!tenantFeatureCache.get(tenantKey)) continue;
    const threshold = thresholdFor(doc.expiresAt, now);
    if (threshold === null) continue;
    checked += 1;
    const result = await notifyDoc(doc, threshold);
    notified += result.notified || 0;
  }
  return { checked, notified };
}

module.exports = {
  sweepDocumentationExpiryNotifications,
  thresholdFor,
};
