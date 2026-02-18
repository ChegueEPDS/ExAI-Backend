const bus = require('../lib/notifications/bus');
const Notification = require('../models/notification');
const ReportExportJob = require('../models/reportExportJob');
const azureBlob = require('../services/azureBlobService');
const { initSse } = require('../services/sseService');
const systemSettings = require('../services/systemSettingsStore');

exports.notificationsStream = (req, res) => {
  const userId = req.userId;
  const tenantId = req.scope?.tenantId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // Ensure no compression is applied on this route (some proxies/bundlers misbehave with SSE + gzip).
  res.setHeader('Content-Encoding', '');
  const send = initSse(req, res, {
    // Some clients treat only SSE "event:" frames as activity; avoid idle disconnects.
    heartbeatMs: (() => {
      const raw = Number(systemSettings.getNumber('NOTIFICATIONS_SSE_HEARTBEAT_MS') || 10_000);
      return Math.max(1000, Math.min(raw, 60000));
    })(),
    heartbeatEvent: 'ping',
  });

  // első “connected” event
  send('connected', { userId, tenantId, ts: new Date().toISOString() });
  // Tell EventSource the default reconnection delay (ms)
  res.write('retry: 2000\n\n');

  // Backward-compat: user-only channel, plus tenant-broadcast if available
  const channels = [`notify:${userId}`];
  if (tenantId) channels.push(`notify:tenant:${tenantId}`);

  const handlers = [];
  channels.forEach((ch) => {
    const handler = (msg) => {
      const topLevel = {
        userId: msg.userId,
        tenantId: msg.tenantId,
        audience: msg.audience || (ch.startsWith('notify:tenant:') ? 'tenant' : 'user'),
        ...msg.payload,
        // expose meta at top-level if present in payload.data
        meta: msg?.payload?.data?.meta || undefined,
        ts: msg.ts
      };
      send(msg.event || 'notification', topLevel);
    };
    bus.on(ch, handler);
    handlers.push({ ch, handler });
  });

  req.on('close', () => {
    handlers.forEach(({ ch, handler }) => bus.off(ch, handler));
    try { res.end(); } catch {}
  });
};

exports.listNotifications = async (req, res) => {
  const userId = req.userId;
  const tenantId = req.scope?.tenantId;
  const includeTenant = String(req.query.includeTenant || 'true') === 'true';
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
  const status = String(req.query.status || 'all').toLowerCase();

  const or = [{ userId }];
  if (includeTenant && tenantId) or.push({ tenantId });

  const q = { $or: or };
  if (status === 'unread') q.status = 'unread';
  if (status === 'read') q.status = 'read';

  const items = await Notification.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  const jobIds = Array.from(
    new Set(
      (items || [])
        .map(it => it?.data?.jobId)
        .filter(Boolean)
    )
  );
  let jobMap = new Map();
  if (jobIds.length) {
    const jobs = await ReportExportJob.find({ jobId: { $in: jobIds } })
      .select('jobId status meta finishedAt createdAt')
      .lean();
    jobMap = new Map(jobs.map(j => [j.jobId, j]));
  }
  const enriched = (items || []).map(it => {
    const jobId = it?.data?.jobId;
    const job = jobId ? jobMap.get(jobId) : null;
    return {
      ...it,
      audience: it.userId ? 'user' : 'tenant',
      data: it?.data || {},
      meta: it?.data?.meta || undefined,
      jobStatus: job?.status || null,
      jobFinishedAt: job?.finishedAt || null
    };
  });
  res.json({ items: enriched });
};

exports.deleteNotification = async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const doc = await Notification.findOne({ _id: id, userId });
  if (!doc) return res.status(404).json({ error: 'Not found' });

  // Best-effort: ha ez egy equipment-docs-import értesítés error XLS-szel, töröljük a blobot is.
  try {
    const type = doc.type;
    const data = doc.data || {};
    const downloadUrl = data.downloadUrl || (data.meta && data.meta.downloadUrl);
    if (type === 'equipment-docs-import' && downloadUrl) {
      const blobPath = azureBlob.toBlobPath(downloadUrl);
      if (blobPath) {
        await azureBlob.deleteFile(blobPath);
      }
    }
  } catch (_) {
    // swallow – notification törlését nem blokkoljuk blob hiba miatt
  }

  await Notification.deleteOne({ _id: id });
  res.json({ deleted: true });
};

exports.markRead = async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  // Only allow marking read on user-addressed notifications to avoid toggling shared tenant notices globally
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
