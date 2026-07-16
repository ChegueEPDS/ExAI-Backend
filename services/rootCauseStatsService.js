const RootCauseStat = require('../models/rootCauseStat');

const pendingInspectionSyncs = new Map();
let inspectionSyncTimer = null;
let activeInspectionSyncs = 0;
const INSPECTION_SYNC_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.ROOT_CAUSE_SYNC_CONCURRENCY || 1), 4)
);

function normalizeNote(value) {
  const text = String(value || '').trim();
  return text ? text.toLowerCase() : 'Unspecified';
}

function inc(map, key, by = 1) {
  map.set(key, Number(map.get(key) || 0) + Number(by || 0));
}

function dateOrFallback(...values) {
  for (const value of values) {
    const d = value ? new Date(value) : null;
    if (d && Number.isFinite(d.getTime())) return d;
  }
  return new Date();
}

async function syncInspectionRootCauseStats(inspection) {
  if (!inspection?._id || !inspection?.tenantId) return;
  if (inspection.status !== 'Failed' || String(inspection.reviewStatus || 'final') === 'pending') {
    await RootCauseStat.deleteOne({ kind: 'compliance', sourceId: inspection._id });
    return;
  }

  const noteCounts = new Map();
  for (const result of inspection.results || []) {
    if (result?.status !== 'Failed') continue;
    inc(noteCounts, normalizeNote(result.note), 1);
  }

  if (!noteCounts.size) {
    await RootCauseStat.deleteOne({ kind: 'compliance', sourceId: inspection._id });
    return;
  }

  await RootCauseStat.updateOne(
    { kind: 'compliance', sourceId: inspection._id },
    {
      $set: {
        tenantId: inspection.tenantId,
        equipmentId: inspection.equipmentId || null,
        sourceId: inspection._id,
        kind: 'compliance',
        occurredAt: dateOrFallback(inspection.inspectionDate, inspection.finalizedAt, inspection.createdAt),
        severity: inspection.failureSeverity || null,
        noteCounts: Object.fromEntries(noteCounts)
      }
    },
    { upsert: true }
  );
}

function drainInspectionSyncQueue() {
  inspectionSyncTimer = null;
  while (activeInspectionSyncs < INSPECTION_SYNC_CONCURRENCY && pendingInspectionSyncs.size) {
    const [key, inspection] = pendingInspectionSyncs.entries().next().value;
    pendingInspectionSyncs.delete(key);
    activeInspectionSyncs += 1;
    syncInspectionRootCauseStats(inspection)
      .catch(() => {})
      .finally(() => {
        activeInspectionSyncs -= 1;
        if (pendingInspectionSyncs.size) scheduleInspectionSyncDrain(50);
      });
  }
}

function scheduleInspectionSyncDrain(delayMs = 50) {
  if (inspectionSyncTimer) return;
  inspectionSyncTimer = setTimeout(drainInspectionSyncQueue, delayMs);
  if (typeof inspectionSyncTimer.unref === 'function') inspectionSyncTimer.unref();
}

function scheduleInspectionRootCauseStats(inspection) {
  if (!inspection?._id) return;
  pendingInspectionSyncs.set(String(inspection._id), inspection);
  scheduleInspectionSyncDrain();
}

async function syncMaintenanceRootCauseStats(event) {
  if (!event?._id || !event?.tenantId) return;
  if (event.kind !== 'fault_reported') {
    await RootCauseStat.deleteOne({ kind: 'maintenance', sourceId: event._id });
    return;
  }

  await RootCauseStat.updateOne(
    { kind: 'maintenance', sourceId: event._id },
    {
      $set: {
        tenantId: event.tenantId,
        equipmentId: event.equipmentId || null,
        sourceId: event._id,
        kind: 'maintenance',
        occurredAt: dateOrFallback(event.occurredAt, event.createdAt),
        severity: event.severity || null,
        noteCounts: { [normalizeNote(event.note)]: 1 }
      }
    },
    { upsert: true }
  );
}

async function getRootCauseTop({ tenantId, kind, equipmentIds = null, from = null, to = null, severities = null, limit = 10 }) {
  const match = { tenantId, kind };
  if (equipmentIds?.length) match.equipmentId = { $in: equipmentIds };
  if (from || to) {
    match.occurredAt = {};
    if (from) match.occurredAt.$gte = from;
    if (to) match.occurredAt.$lte = to;
  }
  if (severities?.length) match.severity = { $in: severities };

  const docs = await RootCauseStat.find(match).select('noteCounts').lean();
  if (!docs.length) return { hasMaterializedRows: false, materializedDocCount: 0, top: [] };

  const counts = new Map();
  for (const doc of docs) {
    for (const [note, count] of Object.entries(doc.noteCounts || {})) {
      inc(counts, note, Number(count || 0));
    }
  }

  const top = Array.from(counts.entries())
    .map(([label, count]) => ({ label: label || 'Unspecified', count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
  return { hasMaterializedRows: true, materializedDocCount: docs.length, top };
}

module.exports = {
  getRootCauseTop,
  scheduleInspectionRootCauseStats,
  syncInspectionRootCauseStats,
  syncMaintenanceRootCauseStats
};
