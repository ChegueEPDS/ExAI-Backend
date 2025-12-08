// lib/notifications/notifier.js
const Notification = require('../../models/notification');
const bus = require('./bus');

/**
 * notifyAndStore(userIdOrNull, options)
 * options: {
 *   type, title, message, data = {}, meta = {},
 *   audience: 'user' | 'tenant' (default: 'user'),
 *   tenantId: ObjectId | string (kell, ha audience='tenant'),
 *   idempotencyKey?: string // opcionális
 * }
 */
async function notifyAndStore(id, {
  type, title, message, data = {}, meta = {},
  audience = 'user',
  tenantId = null,
  idempotencyKey = null
}) {
  if (audience === 'tenant' && !tenantId) {
    throw new Error('notifyAndStore: tenant audience requires tenantId');
  }

  // Idempotencia kulcs: ha nincs, próbáljuk képezni (type + data.jobId alapján)
  const autoKey = (data && data.jobId) ? `${audience}:${type}:${data.jobId}:${audience === 'tenant' ? tenantId : id}` : null;
  const key = idempotencyKey || autoKey || null;

  const baseDoc = {
    userId:   (audience === 'user')   ? (id || 'anonymous') : null,
    tenantId: (audience === 'tenant') ? tenantId           : null,
    type
  };

  const updateDoc = {
    $set: {
      title,
      message,
      data: { ...(data || {}), meta: meta || {} },
      status: 'unread'
    },
    $setOnInsert: baseDoc
  };

  let doc;

  if (key) {
    const filter = {
      type,
      ...(audience === 'user' ? { userId: baseDoc.userId } : { tenantId: baseDoc.tenantId }),
      ...(data?.jobId ? { 'data.jobId': data.jobId } : {}),
    };
    doc = await Notification.findOneAndUpdate(
      filter,
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } else {
    doc = await Notification.create({
      ...baseDoc,
      title,
      message,
      data: { ...(data || {}), meta: meta || {} },
      status: 'unread'
    });
  }

  const payload = {
    id: String(doc._id),
    type: doc.type,
    title: doc.title,
    message: doc.message,
    data: doc.data,
    meta,
    createdAt: doc.createdAt,
  };

  if (audience === 'tenant') {
    bus.emit(`notify:tenant:${tenantId}`, { userId: null, event: 'notification', payload, ts: new Date().toISOString() });
  } else {
    bus.emitTo(doc.userId, 'notification', payload);
  }

  return doc;
}

module.exports = { notifyAndStore };
