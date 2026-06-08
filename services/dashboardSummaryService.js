const crypto = require('crypto');
const mongoose = require('mongoose');
const DashboardSummary = require('../models/dashboardSummary');
const DashboardStatsVersion = require('../models/dashboardStatsVersion');

const rebuildQueue = new Map();
const activeRebuilds = new Set();
const pendingDirtyTenants = new Map();
let drainTimer = null;
let dirtyTimer = null;

const MAX_REBUILD_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.DASHBOARD_SUMMARY_REBUILD_CONCURRENCY || 1), 4)
);
const REBUILD_DELAY_MS = Math.max(
  250,
  Math.min(Number(process.env.DASHBOARD_SUMMARY_REBUILD_DELAY_MS || 1000), 30000)
);
const DEFAULT_MAX_AGE_MS = Math.max(
  60 * 1000,
  Math.min(Number(process.env.DASHBOARD_SUMMARY_MAX_AGE_MS || 10 * 60 * 1000), 24 * 60 * 60 * 1000)
);
const DIRTY_FLUSH_DELAY_MS = Math.max(
  100,
  Math.min(Number(process.env.DASHBOARD_SUMMARY_DIRTY_FLUSH_DELAY_MS || 250), 30000)
);

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function stableStringify(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashParams(params) {
  const raw = stableStringify(params || {});
  if (!raw || raw === '{}') return '';
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function normalizeScope({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  if (!tenantObjectId) throw new Error('Missing tenantId');
  if (zoneId) {
    const zoneObjectId = toObjectId(zoneId);
    if (!zoneObjectId) throw new Error('Invalid zoneId');
    return { tenantObjectId, scopeType: 'zone', scopeId: zoneObjectId };
  }
  if (siteId) {
    const siteObjectId = toObjectId(siteId);
    if (!siteObjectId) throw new Error('Invalid siteId');
    return { tenantObjectId, scopeType: 'site', scopeId: siteObjectId };
  }
  return { tenantObjectId, scopeType: 'tenant', scopeId: null };
}

async function getCurrentVersion(tenantId) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const versionId = `tenant:${String(tenantObjectId)}`;
  const existing = await DashboardStatsVersion.findOne({ _id: versionId })
    .select('version')
    .lean();
  if (existing) return Number(existing.version || 0);
  const doc = await DashboardStatsVersion.findOneAndUpdate(
    { _id: versionId },
    { $setOnInsert: { _id: versionId, tenantId: tenantObjectId, version: 0, reason: 'init' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return Number(doc?.version || 0);
}

function buildKey({ tenantId, kind, siteId = null, zoneId = null, params = {} }) {
  const { tenantObjectId, scopeType, scopeId } = normalizeScope({ tenantId, siteId, zoneId });
  const paramsHash = hashParams(params);
  const summaryId = [
    String(tenantObjectId),
    String(kind || ''),
    scopeType,
    scopeId ? String(scopeId) : '',
    paramsHash
  ].join('|');
  return {
    summaryId,
    tenantId: tenantObjectId,
    kind: String(kind || ''),
    scopeType,
    scopeId,
    paramsHash,
    params: params || {},
    queueKey: summaryId
  };
}

async function saveFreshSummary(key, sourceVersion, summary) {
  const now = new Date();
  await DashboardSummary.updateOne(
    { _id: key.summaryId },
    {
      $set: {
        tenantId: key.tenantId,
        kind: key.kind,
        scopeType: key.scopeType,
        scopeId: key.scopeId,
        paramsHash: key.paramsHash,
        params: key.params,
        sourceVersion,
        status: 'fresh',
        summary,
        calculatedAt: now,
        rebuildFinishedAt: now,
        dirtyAt: null,
        dirtyReason: '',
        errorMessage: ''
      },
      $setOnInsert: { _id: key.summaryId }
    },
    { upsert: true }
  );
  return summary;
}

async function rebuildSummary(job) {
  const { key, loader, sourceVersion } = job;
  const now = new Date();
  await DashboardSummary.updateOne(
    { _id: key.summaryId },
    {
      $set: {
        tenantId: key.tenantId,
        kind: key.kind,
        scopeType: key.scopeType,
        scopeId: key.scopeId,
        paramsHash: key.paramsHash,
        params: key.params,
        status: 'rebuilding',
        rebuildStartedAt: now
      },
      $setOnInsert: { _id: key.summaryId, sourceVersion: 0, summary: {} }
    },
    { upsert: true }
  );
  try {
    const summary = await loader();
    await saveFreshSummary(key, sourceVersion, summary);
  } catch (err) {
    await DashboardSummary.updateOne(
      { _id: key.summaryId },
      {
        $set: {
          status: 'failed',
          errorMessage: err?.message || String(err),
          rebuildFinishedAt: new Date()
        }
      }
    );
  }
}

function scheduleDrain(delayMs = REBUILD_DELAY_MS) {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue().catch(() => {});
  }, delayMs);
  if (typeof drainTimer.unref === 'function') drainTimer.unref();
}

async function drainQueue() {
  while (activeRebuilds.size < MAX_REBUILD_CONCURRENCY && rebuildQueue.size) {
    const [queueKey, job] = rebuildQueue.entries().next().value;
    rebuildQueue.delete(queueKey);
    activeRebuilds.add(queueKey);
    rebuildSummary(job)
      .catch(() => {})
      .finally(() => {
        activeRebuilds.delete(queueKey);
        if (rebuildQueue.size) scheduleDrain(250);
      });
  }
}

function enqueueRebuild(job) {
  if (!job?.key?.queueKey || activeRebuilds.has(job.key.queueKey)) return;
  rebuildQueue.set(job.key.queueKey, job);
  scheduleDrain();
}

function isFreshEnough(doc, maxAgeMs) {
  if (!maxAgeMs) return true;
  const calculatedAt = doc?.calculatedAt ? new Date(doc.calculatedAt).getTime() : 0;
  return calculatedAt && Date.now() - calculatedAt <= maxAgeMs;
}

async function getMaterializedSummary({
  kind,
  tenantId,
  siteId = null,
  zoneId = null,
  params = {},
  loader,
  maxAgeMs = DEFAULT_MAX_AGE_MS
}) {
  const key = buildKey({ tenantId, kind, siteId, zoneId, params });
  if (!key.kind) throw new Error('Missing summary kind');
  if (typeof loader !== 'function') throw new Error('Missing summary loader');

  const sourceVersion = await getCurrentVersion(key.tenantId);
  const doc = await DashboardSummary.findOne({ _id: key.summaryId }).lean();

  if (
    doc?.status === 'fresh' &&
    Number(doc.sourceVersion || 0) === sourceVersion &&
    isFreshEnough(doc, maxAgeMs)
  ) {
    return doc.summary || {};
  }

  if (doc?.summary && Object.keys(doc.summary).length) {
    enqueueRebuild({ key, loader, sourceVersion });
    return doc.summary;
  }

  const summary = await loader();
  return saveFreshSummary(key, sourceVersion, summary);
}

async function markDashboardStatsDirty({ tenantId, reason = 'data_changed' }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  if (!tenantObjectId) return;
  const now = new Date();
  await DashboardStatsVersion.updateOne(
    { _id: `tenant:${String(tenantObjectId)}` },
    {
      $inc: { version: 1 },
      $set: { reason: String(reason || 'data_changed') },
      $setOnInsert: { _id: `tenant:${String(tenantObjectId)}`, tenantId: tenantObjectId }
    },
    { upsert: true }
  );
  await DashboardSummary.updateMany(
    { tenantId: tenantObjectId },
    {
      $set: {
        status: 'dirty',
        dirtyAt: now,
        dirtyReason: String(reason || 'data_changed')
      }
    }
  ).catch(() => {});
}

function scheduleDashboardStatsDirty(args) {
  const tenantObjectId = toObjectId(args?.tenantId) || args?.tenantId;
  if (!tenantObjectId) return;
  const key = String(tenantObjectId);
  const current = pendingDirtyTenants.get(key);
  pendingDirtyTenants.set(key, {
    tenantId: tenantObjectId,
    reason: current?.reason || args?.reason || 'data_changed'
  });
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    const items = Array.from(pendingDirtyTenants.values());
    pendingDirtyTenants.clear();
    items.forEach((item) => markDashboardStatsDirty(item).catch(() => {}));
  }, DIRTY_FLUSH_DELAY_MS);
  if (typeof dirtyTimer.unref === 'function') dirtyTimer.unref();
}

module.exports = {
  getMaterializedSummary,
  markDashboardStatsDirty,
  scheduleDashboardStatsDirty
};
