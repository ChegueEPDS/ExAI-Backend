const mongoose = require('mongoose');
const DashboardIncident = require('../models/dashboardIncident');
const DashboardIncidentState = require('../models/dashboardIncidentState');
const Inspection = require('../models/inspection');
const MaintenanceEvent = require('../models/maintenanceEvent');
const {
  buildComplianceSchemaIncidents,
  buildMaintenanceSchemaIncidents
} = require('./schemaMaintenanceService');

const pendingRecomputes = new Map();
const queuedRecomputes = new Map();
let queueTimer = null;
let activeRecomputes = 0;

const RECOMPUTE_DELAY_MS = 2000;
const RECOMPUTE_BATCH_SIZE = 50;
const RECOMPUTE_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.DASHBOARD_INCIDENT_RECOMPUTE_CONCURRENCY || 1), 2)
);

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function toMillis(value) {
  const d = value instanceof Date ? value : (value ? new Date(value) : null);
  const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  return t;
}

function chunk(items, size = 500) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function buildComplianceIncidents({ tenantId, equipmentIds }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!ids.length) return [];

  const inspections = await Inspection.find({
    tenantId: tenantObjectId,
    equipmentId: { $in: ids },
    $or: [{ schemaId: null }, { schemaId: { $exists: false } }]
  })
    .select('equipmentId status reviewStatus finalizedAt createdAt inspectionDate failureSeverity')
    .sort({ equipmentId: 1, finalizedAt: 1, createdAt: 1, inspectionDate: 1, _id: 1 })
    .lean();

  const incidents = [];
  let currentEq = null;
  let isFailed = false;
  let failedSinceMs = null;
  let failedSeverity = null;

  function flushEq() {
    if (isFailed && failedSinceMs != null) {
      incidents.push({ equipmentId: currentEq, startMs: failedSinceMs, endMs: null, severity: failedSeverity });
    }
    isFailed = false;
    failedSinceMs = null;
    failedSeverity = null;
  }

  const sevRank = { P1: 4, P2: 3, P3: 2, P4: 1 };
  function mergeSeverity(current, next) {
    const a = String(current || '').toUpperCase();
    const b = String(next || '').toUpperCase();
    const ra = sevRank[a] || 0;
    const rb = sevRank[b] || 0;
    if (rb > ra) return b;
    return ra ? a : (rb ? b : null);
  }

  for (const insp of inspections || []) {
    const eqId = insp?.equipmentId ? String(insp.equipmentId) : null;
    if (!eqId) continue;
    if (String(insp?.reviewStatus || 'final') === 'pending') continue;
    if (currentEq == null) currentEq = eqId;
    if (eqId !== currentEq) {
      flushEq();
      currentEq = eqId;
    }
    const t = toMillis(insp?.finalizedAt) ?? toMillis(insp?.createdAt) ?? toMillis(insp?.inspectionDate);
    if (!t) continue;
    if (insp.status === 'Failed') {
      if (!isFailed) {
        isFailed = true;
        failedSinceMs = t;
        failedSeverity = insp.failureSeverity || null;
      } else if (insp.failureSeverity) {
        failedSeverity = mergeSeverity(failedSeverity, insp.failureSeverity);
      }
    } else if (insp.status === 'Passed') {
      if (isFailed && failedSinceMs != null && t >= failedSinceMs) {
        incidents.push({ equipmentId: currentEq, startMs: failedSinceMs, endMs: t, severity: failedSeverity });
      }
      isFailed = false;
      failedSinceMs = null;
      failedSeverity = null;
    }
  }
  flushEq();
  return incidents;
}

async function buildMaintenanceIncidents({ tenantId, equipmentIds }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!ids.length) return [];

  const events = await MaintenanceEvent.find({
    tenantId: tenantObjectId,
    equipmentId: { $in: ids },
    kind: { $in: ['fault_reported', 'repair_started', 'repair_completed'] }
  })
    .select('equipmentId kind occurredAt repairId completedWorking severity')
    .sort({ equipmentId: 1, occurredAt: 1, _id: 1 })
    .lean();

  const incidents = [];
  let currentEq = null;
  let active = false;
  let startedMs = null;
  let repairs = 0;
  let severity = null;

  function flushEq() {
    if (active && startedMs != null) {
      incidents.push({ equipmentId: currentEq, startMs: startedMs, endMs: null, repairs, severity });
    }
    active = false;
    startedMs = null;
    repairs = 0;
    severity = null;
  }

  for (const ev of events || []) {
    const eqId = ev?.equipmentId ? String(ev.equipmentId) : null;
    if (!eqId) continue;
    if (currentEq == null) currentEq = eqId;
    if (eqId !== currentEq) {
      flushEq();
      currentEq = eqId;
    }
    const t = toMillis(ev?.occurredAt);
    if (!t) continue;
    if (ev.kind === 'fault_reported') {
      if (!active) {
        active = true;
        startedMs = t;
        repairs = 0;
        severity = ev.severity || null;
      } else if (!severity && ev.severity) {
        severity = ev.severity;
      }
    } else if (active && ev.kind === 'repair_started') {
      repairs += 1;
    } else if (active && ev.kind === 'repair_completed' && ev.completedWorking === true && t >= startedMs) {
      incidents.push({ equipmentId: currentEq, startMs: startedMs, endMs: t, repairs, severity });
      active = false;
      startedMs = null;
      repairs = 0;
      severity = null;
    }
  }
  flushEq();
  return incidents;
}

function toDocs({ tenantId, kind, incidents }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  return (incidents || [])
    .filter((inc) => inc?.equipmentId && inc?.startMs != null)
    .map((inc) => ({
      tenantId: tenantObjectId,
      equipmentId: toObjectId(inc.equipmentId) || inc.equipmentId,
      kind,
      schemaId: inc.schemaId ? (toObjectId(inc.schemaId) || inc.schemaId) : null,
      schemaName: inc.schemaName || '',
      startAt: new Date(inc.startMs),
      endAt: inc.endMs != null ? new Date(inc.endMs) : null,
      severity: inc.severity || null,
      repairs: Number(inc.repairs || 0)
    }));
}

async function recomputeEquipmentIncidents({ tenantId, equipmentIds }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = Array.from(new Set((equipmentIds || []).filter(Boolean).map(String)))
    .map((id) => toObjectId(id) || id);
  if (!tenantObjectId || !ids.length) return { deleted: 0, inserted: 0 };

  let deleted = 0;
  let inserted = 0;
  for (const part of chunk(ids, 250)) {
    const del = await DashboardIncident.deleteMany({ tenantId: tenantObjectId, equipmentId: { $in: part } });
    deleted += Number(del.deletedCount || 0);

    const [maintenance, compliance, maintenanceSchema, complianceSchema] = await Promise.all([
      buildMaintenanceIncidents({ tenantId: tenantObjectId, equipmentIds: part }),
      buildComplianceIncidents({ tenantId: tenantObjectId, equipmentIds: part }),
      buildMaintenanceSchemaIncidents({ tenantId: tenantObjectId, equipmentIds: part }),
      buildComplianceSchemaIncidents({ tenantId: tenantObjectId, equipmentIds: part })
    ]);

    const docs = [
      ...toDocs({ tenantId: tenantObjectId, kind: 'maintenance', incidents: maintenance }),
      ...toDocs({ tenantId: tenantObjectId, kind: 'compliance', incidents: compliance }),
      ...toDocs({ tenantId: tenantObjectId, kind: 'maintenance-schema', incidents: maintenanceSchema }),
      ...toDocs({ tenantId: tenantObjectId, kind: 'compliance-schema', incidents: complianceSchema })
    ];
    if (docs.length) {
      await DashboardIncident.insertMany(docs, { ordered: false });
      inserted += docs.length;
    }
    await DashboardIncidentState.bulkWrite(
      part.map((equipmentId) => ({
        updateOne: {
          filter: { tenantId: tenantObjectId, equipmentId },
          update: { $set: { rebuiltAt: new Date() } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }
  return { deleted, inserted };
}

function scheduleQueueDrain(delayMs = RECOMPUTE_DELAY_MS) {
  if (queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    drainRecomputeQueue().catch(() => {});
  }, delayMs);
  if (typeof queueTimer.unref === 'function') queueTimer.unref();
}

function enqueueRecompute({ tenantId, equipmentIds }) {
  const tenantKey = String(tenantId || '');
  if (!tenantKey) return;
  const ids = (equipmentIds || []).filter(Boolean).map(String);
  if (!ids.length) return;
  if (!queuedRecomputes.has(tenantKey)) queuedRecomputes.set(tenantKey, new Set());
  const bucket = queuedRecomputes.get(tenantKey);
  ids.forEach((id) => bucket.add(id));
  scheduleQueueDrain();
}

function takeNextQueuedBatch() {
  for (const [tenantKey, ids] of queuedRecomputes.entries()) {
    if (!ids.size) {
      queuedRecomputes.delete(tenantKey);
      continue;
    }
    const batch = [];
    for (const id of ids) {
      batch.push(id);
      ids.delete(id);
      if (batch.length >= RECOMPUTE_BATCH_SIZE) break;
    }
    if (!ids.size) queuedRecomputes.delete(tenantKey);
    return { tenantId: tenantKey, equipmentIds: batch };
  }
  return null;
}

async function drainRecomputeQueue() {
  while (activeRecomputes < RECOMPUTE_MAX_CONCURRENCY) {
    const next = takeNextQueuedBatch();
    if (!next) return;
    activeRecomputes += 1;
    recomputeEquipmentIncidents(next)
      .catch(() => {})
      .finally(() => {
        activeRecomputes -= 1;
        if (queuedRecomputes.size) scheduleQueueDrain(250);
      });
  }
}

function scheduleRecomputeEquipmentIncidents({ tenantId, equipmentId, equipmentIds, delayMs = RECOMPUTE_DELAY_MS }) {
  if (!tenantId) return;
  const ids = equipmentIds || (equipmentId ? [equipmentId] : []);
  if (!ids.length) return;
  const tenantKey = String(tenantId);
  for (const id of ids) {
    const key = `${tenantKey}:${id}`;
    if (pendingRecomputes.has(key)) clearTimeout(pendingRecomputes.get(key));
    const timer = setTimeout(() => {
      pendingRecomputes.delete(key);
      enqueueRecompute({ tenantId, equipmentIds: [id] });
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    pendingRecomputes.set(key, timer);
  }
}

function scheduleBackfillMissingIncidents({ tenantId, equipmentIds, delayMs = RECOMPUTE_DELAY_MS }) {
  if (!tenantId || !equipmentIds?.length) return;
  const timer = setTimeout(() => {
    enqueueRecompute({ tenantId, equipmentIds });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function loadMaterializedIncidents({ tenantId, equipmentIds, from = null, to = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!tenantObjectId || !ids.length) return { complete: false, incidents: [] };
  const incidentFilter = { tenantId: tenantObjectId, equipmentId: { $in: ids } };
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (toDate && !Number.isNaN(toDate.getTime())) incidentFilter.startAt = { $lte: toDate };
  if (fromDate && !Number.isNaN(fromDate.getTime())) {
    incidentFilter.$or = [{ endAt: null }, { endAt: { $gte: fromDate } }];
  }

  const [states, incidents] = await Promise.all([
    DashboardIncidentState.find({ tenantId: tenantObjectId, equipmentId: { $in: ids } }).select('equipmentId').lean(),
    DashboardIncident.find(incidentFilter).lean()
  ]);
  const covered = new Set((states || []).map((state) => String(state.equipmentId)));
  const missingEquipmentIds = ids.filter((id) => !covered.has(String(id)));
  const complete = missingEquipmentIds.length === 0;
  if (missingEquipmentIds.length) {
    scheduleBackfillMissingIncidents({ tenantId: tenantObjectId, equipmentIds: missingEquipmentIds });
  }
  return {
    complete,
    incidents,
    coveredEquipmentIds: Array.from(covered),
    missingEquipmentIds
  };
}

function mapMaterializedIncident(doc) {
  return {
    equipmentId: doc.equipmentId ? String(doc.equipmentId) : null,
    schemaId: doc.schemaId ? String(doc.schemaId) : null,
    schemaName: doc.schemaName || '',
    startMs: toMillis(doc.startAt),
    endMs: toMillis(doc.endAt),
    severity: doc.severity || null,
    repairs: Number(doc.repairs || 0)
  };
}

module.exports = {
  buildComplianceIncidents,
  buildMaintenanceIncidents,
  loadMaterializedIncidents,
  mapMaterializedIncident,
  recomputeEquipmentIncidents,
  scheduleRecomputeEquipmentIncidents,
  scheduleBackfillMissingIncidents
};
