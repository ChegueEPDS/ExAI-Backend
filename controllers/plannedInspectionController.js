const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');
const Site = require('../models/site');
const {
  loadComplianceSchemas,
  loadMaintenanceSchemas,
  maintenanceSchemaIdSets,
  isSchemaAssignment
} = require('../services/schemaMaintenanceService');

function parseLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(20, Math.floor(n));
}

function normalizeScope(scope) {
  const s = String(scope || '').toLowerCase();
  if (s === 'site' || s === 'zone') return s;
  return 'global';
}

function isValidObjectId(id) {
  return !!id && mongoose.Types.ObjectId.isValid(String(id));
}

// GET /api/planned-inspections?scope=global|site|zone&siteId&zoneId&limit=5
// Returns the next N equipments (soonest validUntil first) where the last inspection is Passed.
exports.getPlannedInspections = async (req, res) => {
  try {
    const tenantId = req?.scope?.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'No tenant' });

    const scope = normalizeScope(req.query.scope);
    const siteId = req.query.siteId;
    const zoneId = req.query.zoneId;
    const limit = parseLimit(req.query.limit);

    const dueSourceFilter = {
      $or: [
        { lastInspectionStatus: 'Passed', lastInspectionValidUntil: { $ne: null } },
        { schemaAssignments: { $exists: true, $ne: [] } }
      ]
    };
    const query = {
      tenantId,
      isProcessed: true,
      $and: [dueSourceFilter]
    };

    if (scope === 'site') {
      if (!isValidObjectId(siteId)) return res.status(400).json({ error: 'Invalid siteId' });
      query.Site = siteId;
    }

    if (scope === 'zone') {
      if (!isValidObjectId(siteId)) return res.status(400).json({ error: 'Invalid siteId' });
      if (!isValidObjectId(zoneId)) return res.status(400).json({ error: 'Invalid zoneId' });
      query.Site = siteId;
      const unitIds = await Unit.find({
        tenantId,
        $or: [{ _id: zoneId }, { ancestors: zoneId }]
      }).select('_id').lean();
      const ids = unitIds.map(u => u._id);
      query.$and.push({ $or: [{ Unit: { $in: ids } }, { Zone: { $in: ids } }] });
    }

    const dueRows = await Equipment.find({
      ...query,
      lastInspectionStatus: 'Passed',
      lastInspectionValidUntil: { $ne: null }
    })
      .select('_id EqID TagNo lastInspectionValidUntil Site Unit Zone schemaAssignments')
      .populate({ path: 'Site', select: 'Name', options: { lean: true } })
      .populate({ path: 'Unit', select: 'Name', options: { lean: true } })
      .populate({ path: 'Zone', select: 'Name', options: { lean: true } })
      .sort({ lastInspectionValidUntil: 1, _id: 1 })
      .limit(Math.max(limit * 4, 50))
      .lean();

    const now = Date.now();
    const [maintenanceSchemas, complianceSchemas] = await Promise.all([
      loadMaintenanceSchemas(tenantId),
      loadComplianceSchemas(tenantId)
    ]);
    const typedSchemaGroups = [
      { type: 'maintenance', fallbackName: 'Maintenance schema', schemas: maintenanceSchemas || [] },
      { type: 'compliance', fallbackName: 'Compliance schema', schemas: complianceSchemas || [] }
    ].map((group) => ({
      ...group,
      sets: maintenanceSchemaIdSets(group.schemas),
      byId: new Map((group.schemas || []).map((schema) => [String(schema._id), schema])),
      byKey: new Map((group.schemas || []).filter((schema) => schema.systemKey).map((schema) => [String(schema.systemKey), schema]))
    }));
    const items = [];

    for (const r of dueRows || []) {
      const dueAt = r.lastInspectionValidUntil ? new Date(r.lastInspectionValidUntil) : null;
      const dueMs = dueAt ? dueAt.getTime() : null;
      if (dueMs != null) {
        items.push({
          equipmentId: String(r._id),
          eqId: r.EqID || null,
          tagNo: r.TagNo || null,
          dueAt,
          pastDue: now > dueMs,
          siteName: r.Site?.Name || null,
          zoneName: r.Unit?.Name || r.Zone?.Name || null
        });
      }
    }

    const tenantObjectId = isValidObjectId(tenantId) ? new mongoose.Types.ObjectId(String(tenantId)) : tenantId;
    const schemaMatch = {
      tenantId: tenantObjectId,
      isProcessed: true,
      schemaAssignments: { $exists: true, $ne: [] }
    };
    const schemaAnd = [];
    if (scope === 'site') {
      schemaMatch.Site = new mongoose.Types.ObjectId(String(siteId));
    }
    if (scope === 'zone') {
      schemaMatch.Site = new mongoose.Types.ObjectId(String(siteId));
      const unitIds = await Unit.find({
        tenantId,
        $or: [{ _id: zoneId }, { ancestors: zoneId }]
      }).select('_id').lean();
      const ids = unitIds.map(u => u._id);
      schemaAnd.push({ $or: [{ Unit: { $in: ids } }, { Zone: { $in: ids } }] });
    }
    if (schemaAnd.length) schemaMatch.$and = schemaAnd;
    const schemaPipeline = [
      { $match: schemaMatch },
      { $unwind: '$schemaAssignments' },
      { $match: { 'schemaAssignments.values.nextInspectionDate': { $ne: null } } },
      {
        $project: {
          _id: 1,
          EqID: 1,
          TagNo: 1,
          Site: 1,
          Unit: 1,
          Zone: 1,
          assignment: '$schemaAssignments',
          dueAt: '$schemaAssignments.values.nextInspectionDate'
        }
      },
      { $sort: { dueAt: 1, _id: 1 } },
      { $limit: Math.max(limit * 20, 200) }
    ];
    const schemaRows = await Equipment.aggregate(schemaPipeline);
    const schemaSiteIds = [...new Set((schemaRows || []).map((r) => r.Site).filter(Boolean).map(String))];
    const schemaUnitIds = [...new Set((schemaRows || []).flatMap((r) => [r.Unit, r.Zone]).filter(Boolean).map(String))];
    const [schemaSites, schemaUnits] = await Promise.all([
      schemaSiteIds.length
        ? Site.find({ _id: { $in: schemaSiteIds } }).select('Name').lean()
        : [],
      schemaUnitIds.length
        ? Unit.find({ _id: { $in: schemaUnitIds } }).select('Name').lean()
        : []
    ]);
    const siteNameById = new Map((schemaSites || []).map((s) => [String(s._id), s.Name || null]));
    const unitNameById = new Map((schemaUnits || []).map((u) => [String(u._id), u.Name || null]));

    for (const r of schemaRows || []) {
      const assignment = r.assignment || {};
      const group = typedSchemaGroups.find((candidate) => isSchemaAssignment(assignment, candidate.sets));
      if (!group) continue;
      const next = r.dueAt ? new Date(r.dueAt) : null;
      const nextMs = next && Number.isFinite(next.getTime()) ? next.getTime() : null;
      if (nextMs == null) continue;
      const schema = assignment.schemaId
        ? group.byId.get(String(assignment.schemaId))
        : group.byKey.get(String(assignment.schemaKey || ''));
      items.push({
        equipmentId: String(r._id),
        eqId: r.EqID || null,
        tagNo: r.TagNo || null,
        dueAt: next,
        pastDue: now > nextMs,
        siteName: r.Site ? siteNameById.get(String(r.Site)) || null : null,
        zoneName: r.Unit ? unitNameById.get(String(r.Unit)) || null : (r.Zone ? unitNameById.get(String(r.Zone)) || null : null),
        schemaId: assignment.schemaId ? String(assignment.schemaId) : null,
        schemaName: schema?.name || assignment.schemaKey || group.fallbackName,
        schemaType: group.type
      });
      if (items.length >= Math.max(limit * 6, 60)) {
        break;
      }
    }

    items.sort((a, b) => {
      const at = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bt = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return at - bt;
    });

    const dueSoonCount = (days) => {
      const upper = now + days * 24 * 60 * 60 * 1000;
      return items.filter((item) => {
        const dueMs = item.dueAt ? new Date(item.dueAt).getTime() : null;
        return dueMs != null && Number.isFinite(dueMs) && dueMs >= now && dueMs <= upper;
      }).length;
    };

    return res.json({
      scope: { scope, siteId: scope === 'global' ? null : String(siteId || ''), zoneId: scope === 'zone' ? String(zoneId || '') : null },
      limit,
      summary: {
        pastDue: items.filter((item) => !!item.pastDue).length,
        dueSoon30: dueSoonCount(30),
        dueSoon60: dueSoonCount(60),
        dueSoon90: dueSoonCount(90)
      },
      items: items.slice(0, limit)
    });
  } catch (err) {
    console.error('getPlannedInspections failed:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
