const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');
const Inspection = require('../models/inspection');
const MaintenanceEvent = require('../models/maintenanceEvent');
const Tenant = require('../models/tenant');
const { buildMaintenanceSchemaIncidents, buildComplianceSchemaIncidents } = require('./schemaMaintenanceService');
const {
  loadMaterializedIncidents,
  mapMaterializedIncident
} = require('./dashboardIncidentService');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function toMillis(value) {
  const d = value instanceof Date ? value : (value ? new Date(value) : null);
  const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  return t;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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
    count: q.count,
    totalHours: toHours(q.totalMs),
    minHours: toHours(q.minMs),
    maxHours: toHours(q.maxMs),
    meanHours: toHours(q.meanMs),
    medianHours: toHours(q.medianMs),
    p90Hours: toHours(q.p90Ms)
  };
}

function defaultSlaTargets() {
  return {
    maintenanceHours: { P1: 24, P2: 72, P3: 168, P4: 336 },
    inspectionHours: { P1: 24, P2: 72, P3: 168, P4: 336 }
  };
}

async function loadSlaTargets(tenantId) {
  const t = await Tenant.findById(tenantId).select('dashboardSettings').lean();
  const saved = t?.dashboardSettings?.slaTargets || null;
  const merged = defaultSlaTargets();
  if (saved?.maintenanceHours) {
    for (const k of ['P1', 'P2', 'P3', 'P4']) {
      const v = saved.maintenanceHours[k];
      if (Number.isFinite(Number(v)) && Number(v) >= 0) merged.maintenanceHours[k] = Number(v);
    }
  }
  if (saved?.inspectionHours) {
    for (const k of ['P1', 'P2', 'P3', 'P4']) {
      const v = saved.inspectionHours[k];
      if (Number.isFinite(Number(v)) && Number(v) >= 0) merged.inspectionHours[k] = Number(v);
    }
  }
  return merged;
}

async function resolveEquipments({ tenantId, siteId = null, zoneId = null }) {
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

  const equipments = await Equipment.find(filter).select('_id EqID TagNo Site Unit Zone').lean();
  return equipments || [];
}

function overlapMs(startMs, endMs, fromMs, toMs) {
  if (startMs == null) return 0;
  const s = startMs;
  const e = endMs != null ? endMs : Infinity;
  const from = fromMs != null ? fromMs : -Infinity;
  const to = toMs != null ? toMs : Infinity;
  const a = Math.max(s, from);
  const b = Math.min(e, to);
  return b > a ? b - a : 0;
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
      const sev = insp?.failureSeverity || null;
      if (!isFailed) {
        isFailed = true;
        failedSinceMs = t;
        failedSeverity = sev ? String(sev).toUpperCase() : null;
      } else if (sev) {
        failedSeverity = mergeSeverity(failedSeverity, sev);
      }
      continue;
    }

    if (status === 'Passed') {
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
      continue;
    }

    if (!active) continue;

    if (ev.kind === 'repair_started') {
      repairs += 1;
      continue;
    }

    if (ev.kind === 'repair_completed') {
      if (ev.completedWorking === true && startedMs != null && t >= startedMs) {
        incidents.push({ equipmentId: currentEq, startMs: startedMs, endMs: t, repairs, severity });
        active = false;
        startedMs = null;
        repairs = 0;
        severity = null;
      }
    }
  }

  flushEq();
  return incidents;
}

function filterByWindowStart(incidents, fromMs, toMs) {
  if (fromMs == null && toMs == null) return incidents;
  const from = fromMs != null ? fromMs : -Infinity;
  const to = toMs != null ? toMs : Infinity;
  return (incidents || []).filter((x) => x.startMs != null && x.startMs >= from && x.startMs <= to);
}

function filterByWindowResolved(incidents, fromMs, toMs) {
  if (fromMs == null && toMs == null) return incidents;
  const from = fromMs != null ? fromMs : -Infinity;
  const to = toMs != null ? toMs : Infinity;
  return (incidents || []).filter((x) => x.endMs != null && x.endMs >= from && x.endMs <= to);
}

function computeOpenAging(incidents, nowMs) {
  const open = (incidents || []).filter((x) => x.endMs == null && x.startMs != null);
  const ages = open.map((x) => nowMs - x.startMs).filter((x) => x >= 0);
  const stats = formatStats(ages);
  return { openCount: open.length, ...stats };
}

function computeThroughput(incidents, fromMs, toMs) {
  const started = filterByWindowStart(incidents, fromMs, toMs).length;
  const resolved = filterByWindowResolved(incidents, fromMs, toMs).length;
  return { started, resolved };
}

function computeRepairsHistogram(maintenanceIncidents, fromMs, toMs) {
  const closedInWindow = filterByWindowResolved(maintenanceIncidents, fromMs, toMs);
  const hist = { '1': 0, '2': 0, '3plus': 0 };
  for (const inc of closedInWindow) {
    const r = Number(inc.repairs || 0);
    if (r <= 1) hist['1'] += 1;
    else if (r === 2) hist['2'] += 1;
    else hist['3plus'] += 1;
  }
  return hist;
}

function computeSlaCompliance(incidents, fromMs, toMs, slaTargets, targetKey, equipmentsById = new Map(), kind = 'maintenance') {
  const closed = filterByWindowResolved(incidents, fromMs, toMs);
  const bySeverity = { P1: { within: 0, breach: 0 }, P2: { within: 0, breach: 0 }, P3: { within: 0, breach: 0 }, P4: { within: 0, breach: 0 } };
  let withinAll = 0;
  let breachAll = 0;
  const breachItems = [];

  for (const inc of closed) {
    if (inc.startMs == null || inc.endMs == null) continue;
    const sev = String(inc.severity || '').toUpperCase();
    if (!['P1', 'P2', 'P3', 'P4'].includes(sev)) continue;
    const targetH = Number(slaTargets?.[targetKey]?.[sev] ?? 0);
    const durH = (inc.endMs - inc.startMs) / 1000 / 60 / 60;
    if (durH <= targetH) {
      bySeverity[sev].within += 1;
      withinAll += 1;
    } else {
      bySeverity[sev].breach += 1;
      breachAll += 1;
      const eqId = inc.equipmentId ? String(inc.equipmentId) : null;
      const eq = eqId ? equipmentsById.get(eqId) : null;
      breachItems.push({
        kind,
        equipmentId: eqId,
        eqId: eq?.EqID || null,
        tagNo: eq?.TagNo || null,
        severity: sev,
        startedAt: new Date(inc.startMs).toISOString(),
        resolvedAt: new Date(inc.endMs).toISOString(),
        durationHours: Math.round(durH * 10) / 10,
        targetHours: targetH
      });
    }
  }

  const total = withinAll + breachAll;
  const rate = total ? withinAll / total : null;
  breachItems.sort((a, b) => Number(b.durationHours || 0) - Number(a.durationHours || 0));
  return { total, within: withinAll, breach: breachAll, rate, bySeverity, targets: slaTargets, items: breachItems };
}

function computeRecurrenceRate(incidents, windowMs = 30 * 24 * 3600 * 1000) {
  // Definition: a closed incident is recurrent if next incident start is within windowMs after end.
  const byEq = new Map();
  for (const inc of incidents || []) {
    const eqId = inc.equipmentId ? String(inc.equipmentId) : null;
    if (!eqId || inc.startMs == null) continue;
    if (!byEq.has(eqId)) byEq.set(eqId, []);
    byEq.get(eqId).push(inc);
  }

  let checked = 0;
  let recurrent = 0;
  for (const arr of byEq.values()) {
    const sorted = arr.slice().sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      if (cur.endMs == null) continue;
      const next = sorted[i + 1];
      if (!next || next.startMs == null) continue;
      checked += 1;
      if (next.startMs - cur.endMs <= windowMs) recurrent += 1;
    }
  }

  return { checked, recurrent, rate: checked ? recurrent / checked : null, windowDays: Math.round(windowMs / 86400000) };
}

function computeMtbf(incidents) {
  const byEq = new Map();
  for (const inc of incidents || []) {
    const eqId = inc.equipmentId ? String(inc.equipmentId) : null;
    if (!eqId || inc.startMs == null) continue;
    if (!byEq.has(eqId)) byEq.set(eqId, []);
    byEq.get(eqId).push(inc.startMs);
  }

  const diffs = [];
  for (const starts of byEq.values()) {
    const s = starts.slice().sort((a, b) => a - b);
    for (let i = 1; i < s.length; i += 1) {
      const d = s[i] - s[i - 1];
      if (d >= 0) diffs.push(d);
    }
  }

  return formatStats(diffs);
}

function computeAvailability(incidents, equipmentCount, fromMs, toMs, nowMs) {
  if (!equipmentCount) return { windowHours: null, downtimeHours: 0, downtimePct: null };
  const from = fromMs != null ? fromMs : null;
  const to = toMs != null ? toMs : nowMs;
  const windowMs = to - (from != null ? from : (to - 0));
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { windowHours: null, downtimeHours: 0, downtimePct: null };

  let downtimeMs = 0;
  for (const inc of incidents || []) {
    downtimeMs += overlapMs(inc.startMs, inc.endMs, fromMs, toMs);
  }

  const totalMs = equipmentCount * windowMs;
  return {
    windowHours: toHours(windowMs),
    downtimeHours: toHours(downtimeMs),
    downtimePct: totalMs ? clamp(downtimeMs / totalMs, 0, 1) : null
  };
}

async function computeTopOffenders({ equipmentsById, incidents, fromMs, toMs, limit = 10 }) {
  const map = new Map();
  for (const inc of incidents || []) {
    const eqId = inc.equipmentId ? String(inc.equipmentId) : null;
    if (!eqId) continue;
    const ms = overlapMs(inc.startMs, inc.endMs, fromMs, toMs);
    if (!ms) continue;
    map.set(eqId, (map.get(eqId) || 0) + ms);
  }

  const rows = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([eqId, ms]) => {
      const eq = equipmentsById.get(eqId) || null;
      return {
        equipmentId: eqId,
        eqId: eq?.EqID || null,
        tagNo: eq?.TagNo || null,
        downtimeHours: toHours(ms)
      };
    });

  return rows;
}

function computeTopOffendersBySchema({ equipmentsById, incidents, fromMs, toMs, limit = 5 }) {
  const bySchema = new Map();
  for (const inc of incidents || []) {
    const schemaId = inc.schemaId ? String(inc.schemaId) : '';
    if (!schemaId) continue;
    const eqId = inc.equipmentId ? String(inc.equipmentId) : '';
    if (!eqId) continue;
    const ms = overlapMs(inc.startMs, inc.endMs, fromMs, toMs);
    if (!ms) continue;

    if (!bySchema.has(schemaId)) {
      bySchema.set(schemaId, {
        schemaId,
        name: inc.schemaName || 'Schema',
        offenderMs: new Map()
      });
    }
    const schema = bySchema.get(schemaId);
    schema.offenderMs.set(eqId, (schema.offenderMs.get(eqId) || 0) + ms);
  }

  return Array.from(bySchema.values())
    .map((schema) => ({
      schemaId: schema.schemaId,
      name: schema.name,
      topOffenders: Array.from(schema.offenderMs.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([eqId, ms]) => {
          const eq = equipmentsById.get(eqId) || null;
          return {
            equipmentId: eqId,
            eqId: eq?.EqID || null,
            tagNo: eq?.TagNo || null,
            downtimeHours: toHours(ms)
          };
        })
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function computeSeverityWeightedImpact(maintenanceIncidents, fromMs, toMs) {
  const weights = { P1: 4, P2: 3, P3: 2, P4: 1 };
  let score = 0;
  for (const inc of maintenanceIncidents || []) {
    const sev = String(inc.severity || '').toUpperCase();
    const w = weights[sev] || 0;
    if (!w) continue;
    const ms = overlapMs(inc.startMs, inc.endMs, fromMs, toMs);
    if (!ms) continue;
    score += (ms / 3600000) * w;
  }
  return { scoreHoursWeighted: Math.round(score * 10) / 10, weights };
}

async function computeDashboardAnalytics({ tenantId, siteId = null, zoneId = null, from = null, to = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  if (!tenantObjectId) throw new Error('Missing tenantId');

  const fromMs = from ? toMillis(from) : null;
  const toMs = to ? toMillis(to) : null;
  const nowMs = Date.now();

  const equipments = await resolveEquipments({ tenantId, siteId, zoneId });
  const equipmentCount = equipments.length;
  const equipmentIds = equipments.map((e) => e._id).filter(Boolean);
  const equipmentsById = new Map(equipments.map((e) => [String(e._id), e]));

  const [slaTargets, materialized] = await Promise.all([
    loadSlaTargets(tenantObjectId),
    loadMaterializedIncidents({ tenantId: tenantObjectId, equipmentIds })
  ]);

  let complianceIncidents;
  let complianceSchemaIncidents;
  let maintenanceIncidents;
  let maintenanceSchemaIncidents;

  const materializedIncidents = materialized.incidents || [];
  complianceIncidents = materializedIncidents
    .filter((doc) => doc.kind === 'compliance')
    .map(mapMaterializedIncident);
  complianceSchemaIncidents = materializedIncidents
    .filter((doc) => doc.kind === 'compliance-schema')
    .map(mapMaterializedIncident);
  maintenanceIncidents = materializedIncidents
    .filter((doc) => doc.kind === 'maintenance')
    .map(mapMaterializedIncident);
  maintenanceSchemaIncidents = materializedIncidents
    .filter((doc) => doc.kind === 'maintenance-schema')
    .map(mapMaterializedIncident);

  const missingEquipmentIds = materialized.complete
    ? []
    : (materialized.missingEquipmentIds?.length ? materialized.missingEquipmentIds : equipmentIds);
  if (missingEquipmentIds.length) {
    const [rawCompliance, rawComplianceSchemas, rawMaintenance, rawMaintenanceSchemas] = await Promise.all([
      buildComplianceIncidents({ tenantId: tenantObjectId, equipmentIds: missingEquipmentIds }),
      buildComplianceSchemaIncidents({ tenantId: tenantObjectId, equipmentIds: missingEquipmentIds }),
      buildMaintenanceIncidents({ tenantId: tenantObjectId, equipmentIds: missingEquipmentIds }),
      buildMaintenanceSchemaIncidents({ tenantId: tenantObjectId, equipmentIds: missingEquipmentIds })
    ]);
    complianceIncidents = complianceIncidents.concat(rawCompliance);
    complianceSchemaIncidents = complianceSchemaIncidents.concat(rawComplianceSchemas);
    maintenanceIncidents = maintenanceIncidents.concat(rawMaintenance);
    maintenanceSchemaIncidents = maintenanceSchemaIncidents.concat(rawMaintenanceSchemas);
  }

  // Process MTTR view: closed durations of incidents that started in window
  const mttrMaintenance = formatStats(
    filterByWindowStart(maintenanceIncidents, fromMs, toMs)
      .filter((x) => x.endMs != null)
      .map((x) => x.endMs - x.startMs)
  );
  const mttrMaintenanceSchemas = formatStats(
    filterByWindowStart(maintenanceSchemaIncidents, fromMs, toMs)
      .filter((x) => x.endMs != null)
      .map((x) => x.endMs - x.startMs)
  );
  const mttrCompliance = formatStats(
    filterByWindowStart(complianceIncidents, fromMs, toMs)
      .filter((x) => x.endMs != null)
      .map((x) => x.endMs - x.startMs)
  );
  const mttrComplianceSchemas = formatStats(
    filterByWindowStart(complianceSchemaIncidents, fromMs, toMs)
      .filter((x) => x.endMs != null)
      .map((x) => x.endMs - x.startMs)
  );

  const openAgingMaintenance = computeOpenAging(maintenanceIncidents, nowMs);
  const openAgingMaintenanceSchemas = computeOpenAging(maintenanceSchemaIncidents, nowMs);
  const openAgingCompliance = computeOpenAging(complianceIncidents, nowMs);
  const openAgingComplianceSchemas = computeOpenAging(complianceSchemaIncidents, nowMs);
  const openAgingOverall = computeOpenAging([...maintenanceIncidents, ...maintenanceSchemaIncidents, ...complianceIncidents, ...complianceSchemaIncidents], nowMs);

  const throughputMaintenance = computeThroughput(maintenanceIncidents, fromMs, toMs);
  const throughputMaintenanceSchemas = computeThroughput(maintenanceSchemaIncidents, fromMs, toMs);
  const throughputCompliance = computeThroughput(complianceIncidents, fromMs, toMs);
  const throughputComplianceSchemas = computeThroughput(complianceSchemaIncidents, fromMs, toMs);

  const repairsHistogram = computeRepairsHistogram(maintenanceIncidents, fromMs, toMs);
  const sla = computeSlaCompliance(maintenanceIncidents, fromMs, toMs, slaTargets, 'maintenanceHours', equipmentsById, 'maintenance');
  const schemaSla = computeSlaCompliance(maintenanceSchemaIncidents, fromMs, toMs, slaTargets, 'maintenanceHours', equipmentsById, 'maintenance-schema');
  const inspectionSla = computeSlaCompliance(complianceIncidents, fromMs, toMs, slaTargets, 'inspectionHours', equipmentsById, 'compliance');
  const schemaInspectionSla = computeSlaCompliance(complianceSchemaIncidents, fromMs, toMs, slaTargets, 'inspectionHours', equipmentsById, 'compliance-schema');

  const recurrenceMaintenance = computeRecurrenceRate(maintenanceIncidents);
  const recurrenceMaintenanceSchemas = computeRecurrenceRate(maintenanceSchemaIncidents);
  const recurrenceCompliance = computeRecurrenceRate(complianceIncidents);
  const recurrenceComplianceSchemas = computeRecurrenceRate(complianceSchemaIncidents);

  const mtbfMaintenance = computeMtbf(maintenanceIncidents);
  const mtbfMaintenanceSchemas = computeMtbf(maintenanceSchemaIncidents);
  const mtbfCompliance = computeMtbf(complianceIncidents);
  const mtbfComplianceSchemas = computeMtbf(complianceSchemaIncidents);

  const availabilityMaintenance = computeAvailability(maintenanceIncidents, equipmentCount, fromMs, toMs, nowMs);
  const availabilityMaintenanceSchemas = computeAvailability(maintenanceSchemaIncidents, equipmentCount, fromMs, toMs, nowMs);
  const availabilityCompliance = computeAvailability(complianceIncidents, equipmentCount, fromMs, toMs, nowMs);
  const availabilityComplianceSchemas = computeAvailability(complianceSchemaIncidents, equipmentCount, fromMs, toMs, nowMs);

  const topMaintenance = await computeTopOffenders({ equipmentsById, incidents: maintenanceIncidents, fromMs, toMs, limit: 10 });
  const topMaintenanceSchemas = await computeTopOffenders({ equipmentsById, incidents: maintenanceSchemaIncidents, fromMs, toMs, limit: 10 });
  const topCompliance = await computeTopOffenders({ equipmentsById, incidents: complianceIncidents, fromMs, toMs, limit: 10 });
  const topComplianceSchemas = await computeTopOffenders({ equipmentsById, incidents: complianceSchemaIncidents, fromMs, toMs, limit: 10 });
  const maintenanceSchemaOffenders = computeTopOffendersBySchema({ equipmentsById, incidents: maintenanceSchemaIncidents, fromMs, toMs, limit: 5 });
  const complianceSchemaOffenders = computeTopOffendersBySchema({ equipmentsById, incidents: complianceSchemaIncidents, fromMs, toMs, limit: 5 });

  const severityImpact = computeSeverityWeightedImpact(maintenanceIncidents, fromMs, toMs);
  const schemaSeverityImpact = computeSeverityWeightedImpact(maintenanceSchemaIncidents, fromMs, toMs);

  return {
    scope: {
      siteId: siteId || null,
      zoneId: zoneId || null,
      from: fromMs ? new Date(fromMs).toISOString() : null,
      to: toMs ? new Date(toMs).toISOString() : null,
      equipmentCount
    },
    slaTargets,
    overall: {
      openAging: openAgingOverall
    },
    maintenance: {
      mttr: mttrMaintenance,
      openAging: openAgingMaintenance,
      throughput: throughputMaintenance,
      repairsHistogram,
      sla,
      recurrence: recurrenceMaintenance,
      mtbf: mtbfMaintenance,
      availability: availabilityMaintenance,
      severityImpact,
      topOffenders: topMaintenance
    },
    maintenanceSchemas: {
      mttr: mttrMaintenanceSchemas,
      openAging: openAgingMaintenanceSchemas,
      throughput: throughputMaintenanceSchemas,
      repairsHistogram: { '1': 0, '2': 0, '3plus': 0 },
      sla: schemaSla,
      recurrence: recurrenceMaintenanceSchemas,
      mtbf: mtbfMaintenanceSchemas,
      availability: availabilityMaintenanceSchemas,
      severityImpact: schemaSeverityImpact,
      topOffenders: topMaintenanceSchemas,
      bySchemaTopOffenders: maintenanceSchemaOffenders
    },
    compliance: {
      mttr: mttrCompliance,
      openAging: openAgingCompliance,
      throughput: throughputCompliance,
      sla: inspectionSla,
      recurrence: recurrenceCompliance,
      mtbf: mtbfCompliance,
      availability: availabilityCompliance,
      topOffenders: topCompliance
    },
    complianceSchemas: {
      mttr: mttrComplianceSchemas,
      openAging: openAgingComplianceSchemas,
      throughput: throughputComplianceSchemas,
      sla: schemaInspectionSla,
      recurrence: recurrenceComplianceSchemas,
      mtbf: mtbfComplianceSchemas,
      availability: availabilityComplianceSchemas,
      topOffenders: topComplianceSchemas,
      bySchemaTopOffenders: complianceSchemaOffenders
    }
  };
}

module.exports = { computeDashboardAnalytics };
