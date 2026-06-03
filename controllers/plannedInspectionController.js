const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');
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

    const rows = await Equipment.find(query)
      .select('_id EqID TagNo lastInspectionValidUntil Site Unit Zone schemaAssignments')
      .populate({ path: 'Site', select: 'Name', options: { lean: true } })
      .populate({ path: 'Unit', select: 'Name', options: { lean: true } })
      .populate({ path: 'Zone', select: 'Name', options: { lean: true } })
      .sort({ lastInspectionValidUntil: 1, _id: 1 })
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

    for (const r of rows || []) {
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

      for (const assignment of r.schemaAssignments || []) {
        const group = typedSchemaGroups.find((candidate) => isSchemaAssignment(assignment, candidate.sets));
        if (!group) continue;
        const next = assignment.values?.nextInspectionDate ? new Date(assignment.values.nextInspectionDate) : null;
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
          siteName: r.Site?.Name || null,
          zoneName: r.Unit?.Name || r.Zone?.Name || null,
          schemaId: assignment.schemaId ? String(assignment.schemaId) : null,
          schemaName: schema?.name || assignment.schemaKey || group.fallbackName,
          schemaType: group.type
        });
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
