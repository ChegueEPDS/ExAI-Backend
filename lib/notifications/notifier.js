// lib/notifications/notifier.js
const Notification = require('../../models/notification');
const bus = require('./bus');

/**
 * Egységes értesítő:
 * - DB-be ment
 * - SSE-n push
 * - meta: { route, query } => hova menjen kattintáskor
 */
async function notifyAndStore(userId, { type, title, message, data = {}, meta = {} }) {
  if (!userId) userId = 'anonymous';

  const doc = await Notification.create({
    userId,
    type,
    title,
    message,
    data: { ...(data || {}), meta: meta || {} },
    status: 'unread'
  });

  const payload = {
    id: doc._id.toString(),
    type: doc.type,
    title: doc.title,
    message: doc.message,
    data: doc.data, // tartalmazza data.meta-t is
    meta,           // SSE-n külön is
    createdAt: doc.createdAt,
  };

  bus.emitTo(userId, 'notification', payload); // egységes eventnév

  return doc;
}

module.exports = { notifyAndStore };