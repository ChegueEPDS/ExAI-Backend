const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const Unit = require('../models/unit');
const MaintenanceEvent = require('../models/maintenanceEvent');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function toMillis(value) {
  const d = value instanceof Date ? value : (value ? new Date(value) : null);
  const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  return t;
}

function quantiles(valuesMs) {
  const arr = (valuesMs || []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  const n = arr.length;
  if (!n) {
    return { count: 0, minMs: null, maxMs: null, meanMs: null, medianMs: null, p90Ms: null, totalMs: 0 };
  }
  const totalMs = arr.reduce((s, v) => s + v, 0);
  const meanMs = totalMs / n;
  const medianMs = arr[Math.floor((n - 1) / 2)];
  const p90Ms = arr[Math.max(0, Math.floor(0.9 * (n - 1)))];
  return {
    count: n,
    minMs: arr[0],
    maxMs: arr[n - 1],
    meanMs,
    medianMs,
    p90Ms,
    totalMs
  };
}

function toHours(ms) {
  return ms == null ? null : ms / 1000 / 60 / 60;
}

function formatStats(valuesMs) {
  const q = quantiles(valuesMs);
  return {
    countClosed: q.count,
    totalHours: toHours(q.totalMs),
    minHours: toHours(q.minMs),
    maxHours: toHours(q.maxMs),
    meanHours: toHours(q.meanMs),
    medianHours: toHours(q.medianMs),
    p90Hours: toHours(q.p90Ms)
  };
}

function normalizeSeverities(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  const s = new Set(
    arr
      .flatMap((v) => String(v || '').split(','))
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  );
  const out = Array.from(s).filter((x) => x === 'P1' || x === 'P2' || x === 'P3' || x === 'P4');
  return out.length ? out : null;
}

function normalizeMode(mode) {
  const m = String(mode || 'start').toLowerCase();
  if (m === 'start' || m === 'resolved' || m === 'overlap') return m;
  return 'start';
}

function applyWindow(incident, { fromMs, toMs, mode }) {
  const start = incident.startMs;
  const end = incident.endMs; // may be null
  if (fromMs == null && toMs == null) return true;

  const from = fromMs != null ? fromMs : -Infinity;
  const to = toMs != null ? toMs : Infinity;

  if (mode === 'start') return start != null && start >= from && start <= to;
  if (mode === 'resolved') return end != null && end >= from && end <= to;
  // overlap
  const effectiveEnd = end != null ? end : Infinity;
  return start != null && start <= to && effectiveEnd >= from;
}

async function resolveEquipmentIds({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const siteObjectId = siteId ? toObjectId(siteId) : null;
  const zoneObjectId = zoneId ? toObjectId(zoneId) : null;
  if (!tenantObjectId) throw new Error('Missing tenantId');
  if (siteId && !siteObjectId) throw new Error('Invalid siteId');
  if (zoneId && !zoneObjectId) throw new Error('Invalid zoneId');

  const filter = { tenantId: tenantObjectId };
  if (siteObjectId) filter.Site = siteObjectId;
  if (zoneObjectId) {
    const unitIds = await Unit.find({
      tenantId: tenantObjectId,
      $or: [{ _id: zoneObjectId }, { ancestors: zoneObjectId }]
    }).select('_id').lean();
    const ids = unitIds.map(u => u._id);
    filter.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
  }

  const equipments = await Equipment.find(filter).select('_id').lean();
  return (equipments || []).map((e) => e._id).filter(Boolean);
}

async function computeComplianceMetrics({ tenantId, equipmentIds, fromMs = null, toMs = null, mode = 'start' }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!ids.length) {
    const empty = { ...formatStats([]), countOpen: 0 };
    Object.defineProperty(empty, '__durationsMs', { value: [], enumerable: false });
    return empty;
  }

  const inspections = await Inspection.find({
    tenantId: tenantObjectId,
    equipmentId: { $in: ids }
  })
    .select('equipmentId status reviewStatus finalizedAt createdAt inspectionDate')
    .sort({ equipmentId: 1, finalizedAt: 1, createdAt: 1, inspectionDate: 1, _id: 1 })
    .lean();

  const incidents = [];

  let currentEq = null;
  let isFailed = false;
  let failedSinceMs = null;

  function flushEq() {
    if (isFailed && failedSinceMs != null) incidents.push({ startMs: failedSinceMs, endMs: null });
    isFailed = false;
    failedSinceMs = null;
  }

  for (const insp of inspections || []) {
    const eqId = insp?.equipmentId ? String(insp.equipmentId) : null;
    if (!eqId) continue;

    const reviewStatus = insp?.reviewStatus || 'final';
    if (String(reviewStatus) === 'pending') continue;

    if (currentEq == null) currentEq = eqId;
    if (eqId !== currentEq) {
      flushEq();
      currentEq = eqId;
    }

    const status = insp?.status || null;
    const t = toMillis(insp?.finalizedAt) ?? toMillis(insp?.createdAt) ?? toMillis(insp?.inspectionDate);
    if (!t) continue;

    if (status === 'Failed') {
      if (!isFailed) {
        isFailed = true;
        failedSinceMs = t;
      }
      continue;
    }

    if (status === 'Passed') {
      if (isFailed && failedSinceMs != null && t >= failedSinceMs) {
        incidents.push({ startMs: failedSinceMs, endMs: t });
      }
      isFailed = false;
      failedSinceMs = null;
    }
  }

  flushEq();

  const filtered = incidents.filter((inc) => applyWindow(inc, { fromMs, toMs, mode }));
  const closedDurations = filtered.filter((x) => x.endMs != null).map((x) => x.endMs - x.startMs);
  const openCount = filtered.filter((x) => x.endMs == null).length;

  const out = { ...formatStats(closedDurations), countOpen: openCount };
  Object.defineProperty(out, '__durationsMs', { value: closedDurations, enumerable: false });
  return out;
}

async function computeMaintenanceMetrics({
  tenantId,
  equipmentIds,
  fromMs = null,
  toMs = null,
  mode = 'start',
  severities = null
}) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!ids.length) {
    const empty = { ...formatStats([]), countOpen: 0, meanRepairsPerIncident: 0 };
    Object.defineProperty(empty, '__durationsMs', { value: [], enumerable: false });
    return empty;
  }

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
    if (active && startedMs != null) incidents.push({ startMs: startedMs, endMs: null, repairs, severity });
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
      continue;
    }

    if (!active) continue;

    if (ev.kind === 'repair_started') {
      repairs += 1;
      continue;
    }

    if (ev.kind === 'repair_completed') {
      if (ev.completedWorking === true && startedMs != null && t >= startedMs) {
        incidents.push({ startMs: startedMs, endMs: t, repairs, severity });
        active = false;
        startedMs = null;
        repairs = 0;
        severity = null;
      }
    }
  }

  flushEq();

  const severitiesNorm = normalizeSeverities(severities);
  const filtered = incidents
    .filter((inc) => applyWindow(inc, { fromMs, toMs, mode }))
    .filter((inc) => {
      if (!severitiesNorm) return true;
      return inc.severity && severitiesNorm.includes(String(inc.severity).toUpperCase());
    });

  const closedDurations = filtered.filter((x) => x.endMs != null).map((x) => x.endMs - x.startMs);
  const openCount = filtered.filter((x) => x.endMs == null).length;
  const repairCounts = filtered.filter((x) => x.endMs != null).map((x) => Number(x.repairs || 0));
  const meanRepairsPerIncident =
    repairCounts.length ? repairCounts.reduce((s, v) => s + v, 0) / repairCounts.length : 0;

  const out = { ...formatStats(closedDurations), countOpen: openCount, meanRepairsPerIncident };
  Object.defineProperty(out, '__durationsMs', { value: closedDurations, enumerable: false });
  return out;
}

async function computeHealthMetrics({
  tenantId,
  siteId = null,
  zoneId = null,
  from = null,
  to = null,
  mode = 'start',
  severity = null
}) {
  const equipmentIds = await resolveEquipmentIds({ tenantId, siteId, zoneId });
  const fromMs = from ? toMillis(from) : null;
  const toMs = to ? toMillis(to) : null;
  const normalizedMode = normalizeMode(mode);
  const [compliance, maintenance] = await Promise.all([
    computeComplianceMetrics({ tenantId, equipmentIds, fromMs, toMs, mode: normalizedMode }),
    computeMaintenanceMetrics({
      tenantId,
      equipmentIds,
      fromMs,
      toMs,
      mode: normalizedMode,
      severities: severity
    })
  ]);

  const complianceDurations = Array.isArray(compliance.__durationsMs) ? compliance.__durationsMs : [];
  const maintenanceDurations = Array.isArray(maintenance.__durationsMs) ? maintenance.__durationsMs : [];
  const combinedDurations = [...complianceDurations, ...maintenanceDurations];
  const overallStats = formatStats(combinedDurations);

  return {
    scope: {
      siteId: siteId || null,
      zoneId: zoneId || null,
      equipmentCount: equipmentIds.length,
      from: fromMs ? new Date(fromMs).toISOString() : null,
      to: toMs ? new Date(toMs).toISOString() : null,
      mode: normalizedMode,
      severity: normalizeSeverities(severity)
    },
    compliance,
    maintenance,
    overall: {
      ...overallStats,
      countOpen: (compliance.countOpen || 0) + (maintenance.countOpen || 0)
    }
  };
}

module.exports = { computeHealthMetrics };
