// Backend/lib/notifications/notifier.js
const Notification = require('../../models/notification');
const bus = require('./bus');

async function notifyAndStore(userId, { type, title, message, data }) {
  if (!userId) userId = 'anonymous';
  const doc = await Notification.create({
    userId, type, title, message, data: data || {}, status: 'unread'
  });

  const payload = {
    id: doc._id.toString(),
    type: doc.type,
    title: doc.title,
    message: doc.message,
    data: doc.data,
    createdAt: doc.createdAt,
  };

  // real-time push (SSE-hez)
  bus.emit(`notify:${userId}`, {
    userId,
    event: 'notification',
    payload,
    ts: new Date().toISOString()
  });

  return doc;
}

module.exports = { notifyAndStore };