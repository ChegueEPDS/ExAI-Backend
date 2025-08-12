const bus = require('../lib/notifications/bus');
const Notification = require('../models/notification');

exports.notificationsStream = (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // első “connected” event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId, ts: new Date().toISOString() })}\n\n`);

  const channel = `notify:${userId}`;
  const handler = (msg) => {
    res.write(`event: ${msg.event || 'notification'}\n`);
    res.write(`data: ${JSON.stringify({ userId: msg.userId, ...msg.payload, ts: msg.ts })}\n\n`);
  };

  bus.on(channel, handler);
  const ping = setInterval(() => res.write(`: ping\n\n`), 30000);

  req.on('close', () => {
    clearInterval(ping);
    bus.off(channel, handler);
    try { res.end(); } catch {}
  });
};

exports.listNotifications = async (req, res) => {
  const userId = req.userId;
  const unreadOnly = String(req.query.unreadOnly || 'true') === 'true';
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

  const q = { userId };
  if (unreadOnly) q.status = 'unread';

  const items = await Notification.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ items });
};

exports.markRead = async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const doc = await Notification.findOne({ _id: id, userId });
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'read') {
    doc.status = 'read';
    doc.readAt = new Date();
    await doc.save();
  }
  res.json({ ok: true });
};

exports.markAllRead = async (req, res) => {
  const userId = req.userId;
  const r = await Notification.updateMany(
    { userId, status: 'unread' },
    { $set: { status: 'read', readAt: new Date() } }
  );
  res.json({ ok: true, modified: r.modifiedCount });
};