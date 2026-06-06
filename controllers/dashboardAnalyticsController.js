const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');
const MaintenanceEvent = require('../models/maintenanceEvent');
const { computeDashboardAnalytics } = require('../services/dashboardAnalyticsService');
const { getOrSet, ttlMsFromEnv } = require('../services/shortTtlCache');
const {
  assignmentStatus,
  isSchemaAssignment,
  loadComplianceSchemas,
  loadMaintenanceSchemas,
  maintenanceSchemaIdSets
} = require('../services/schemaMaintenanceService');

function parseDateOrNull(input) {
  if (!input) return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function bucketDateForCache(date, bucketMs = 5 * 60 * 1000) {
  if (!date) return null;
  const t = date.getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(Math.floor(t / bucketMs) * bucketMs).toISOString();
}

exports.getDashboardAnalytics = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const scope = String(req.query.scope || 'global');
    const siteId = scope === 'site' || scope === 'zone' ? (req.query.siteId ? String(req.query.siteId) : null) : null;
    const zoneId = scope === 'zone' ? (req.query.zoneId ? String(req.query.zoneId) : null) : null;
    const from = parseDateOrNull(req.query.from);
    const to = parseDateOrNull(req.query.to);

    const cacheKey = JSON.stringify({
      tenantId: String(tenantId),
      scope,
      siteId,
      zoneId,
      from: bucketDateForCache(from),
      to: bucketDateForCache(to)
    });
    const data = await getOrSet(
      'dashboard-analytics',
      cacheKey,
      ttlMsFromEnv('DASHBOARD_ANALYTICS_CACHE_TTL_MS', 15_000),
      () => computeDashboardAnalytics({ tenantId, siteId, zoneId, from, to })
    );
    return res.json(data);
  } catch (error) {
    console.error('❌ getDashboardAnalytics error:', error);
    return res.status(500).json({ message: 'Failed to compute dashboard analytics.' });
  }
};

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function buildEquipmentScopeFilter({ tenantId, siteId = null, zoneId = null }) {
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
    const ids = unitIds.map((u) => u._id);
    filter.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
  }
  return { filter, tenantObjectId };
}

async function computePendingRepairSet({ tenantObjectId, equipmentIds }) {
  if (!tenantObjectId || !equipmentIds?.length) return new Set();
  const latestStarts = await MaintenanceEvent.aggregate([
    { $match: { tenantId: tenantObjectId, equipmentId: { $in: equipmentIds }, kind: 'repair_started' } },
    { $sort: { occurredAt: -1, _id: -1 } },
    { $group: { _id: '$equipmentId', repairId: { $first: '$repairId' } } },
    {
      $lookup: {
        from: 'maintenanceevents',
        let: { rid: '$repairId', eq: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', tenantObjectId] },
                  { $eq: ['$equipmentId', '$$eq'] },
                  { $eq: ['$kind', 'repair_completed'] },
                  { $eq: ['$repairId', '$$rid'] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: 'completion'
      }
    },
    { $project: { _id: 1, isPending: { $eq: [{ $size: '$completion' }, 0] } } }
  ]);
  return new Set((latestStarts || []).filter((x) => x?.isPending && x._id).map((x) => String(x._id)));
}

function normalizeBucket(raw) {
  const bucket = String(raw || '').trim();
  if (['failed', 'pending', 'operating', 'passed', 'na', 'passedOperating', 'naPending'].includes(bucket)) return bucket;
  return '';
}

function equipmentLabel(eq) {
  return eq?.TagNo || eq?.EqID || (eq?._id ? String(eq._id) : 'Equipment');
}

function toDrilldownItem(eq, status) {
  return {
    equipmentId: String(eq._id),
    eqId: eq.EqID || null,
    tagNo: eq.TagNo || null,
    label: equipmentLabel(eq),
    siteId: eq.Site?._id ? String(eq.Site._id) : (eq.Site ? String(eq.Site) : null),
    siteName: eq.Site?.Name || null,
    zoneId: eq.Unit?._id ? String(eq.Unit._id) : (eq.Zone?._id ? String(eq.Zone._id) : (eq.Unit || eq.Zone ? String(eq.Unit || eq.Zone) : null)),
    zoneName: eq.Unit?.Name || eq.Zone?.Name || null,
    status
  };
}

exports.getDashboardEquipmentDrilldown = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const scope = String(req.query.scope || 'global');
    const siteId = scope === 'site' || scope === 'zone' ? (req.query.siteId ? String(req.query.siteId) : null) : null;
    const zoneId = scope === 'zone' ? (req.query.zoneId ? String(req.query.zoneId) : null) : null;
    const category = String(req.query.category || '').trim();
    const bucket = normalizeBucket(req.query.bucket);
    const schemaId = req.query.schemaId ? String(req.query.schemaId) : null;
    if (!category || !bucket) return res.status(400).json({ message: 'category and bucket are required.' });

    const { filter, tenantObjectId } = await buildEquipmentScopeFilter({ tenantId, siteId, zoneId });
    const equipments = await Equipment.find(filter)
      .select('_id EqID TagNo Site Unit Zone operationalStatus lastInspectionStatus schemaAssignments')
      .populate({ path: 'Site', select: 'Name', options: { lean: true } })
      .populate({ path: 'Unit', select: 'Name', options: { lean: true } })
      .populate({ path: 'Zone', select: 'Name', options: { lean: true } })
      .sort({ TagNo: 1, EqID: 1, _id: 1 })
      .lean();

    const equipmentIds = (equipments || []).map((eq) => eq._id).filter(Boolean);
    const pendingSet = await computePendingRepairSet({ tenantObjectId, equipmentIds });
    let schemas = [];
    let schemaSets = null;
    if (category === 'maintenanceSchema' || category === 'complianceSchema') {
      schemas = category === 'maintenanceSchema'
        ? await loadMaintenanceSchemas(tenantObjectId)
        : await loadComplianceSchemas(tenantObjectId);
      schemaSets = maintenanceSchemaIdSets(schemas);
    }

    const items = [];
    for (const eq of equipments || []) {
      const id = eq?._id ? String(eq._id) : '';
      if (!id) continue;
      let status = null;

      if (category === 'overall') {
        const op = eq.operationalStatus || 'operating';
        const compliance = eq.lastInspectionStatus || 'NA';
        if (pendingSet.has(id)) status = 'naPending';
        else if (op === 'failed' || compliance === 'Failed') status = 'failed';
        else if (compliance === 'NA') status = 'naPending';
        else status = 'passedOperating';
      } else if (category === 'maintenance') {
        if (pendingSet.has(id)) status = 'pending';
        else if ((eq.operationalStatus || 'operating') === 'failed') status = 'failed';
        else status = 'operating';
      } else if (category === 'compliance') {
        const compliance = eq.lastInspectionStatus || 'NA';
        status = compliance === 'Failed' ? 'failed' : compliance === 'Passed' ? 'passed' : 'na';
      } else if (category === 'maintenanceSchema' || category === 'complianceSchema') {
        const assignment = (eq.schemaAssignments || []).find((candidate) => {
          if (!isSchemaAssignment(candidate, schemaSets)) return false;
          if (!schemaId) return true;
          return String(candidate.schemaId || candidate.schemaKey || '') === schemaId;
        });
        if (!assignment) continue;
        const raw = assignmentStatus(assignment.values || {});
        status = category === 'maintenanceSchema'
          ? raw
          : raw === 'operating'
            ? 'passed'
            : raw === 'pending'
              ? 'na'
              : 'failed';
      }

      if (status === bucket) items.push(toDrilldownItem(eq, status));
    }

    return res.json({ category, bucket, schemaId, count: items.length, items });
  } catch (error) {
    console.error('❌ getDashboardEquipmentDrilldown error:', error);
    return res.status(500).json({ message: 'Failed to fetch dashboard equipment drilldown.' });
  }
};
