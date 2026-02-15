const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const MaintenanceEvent = require('../models/maintenanceEvent');
const Inspection = require('../models/inspection');
const Unit = require('../models/unit');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function parseDateOrNull(input) {
  if (!input) return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseLimit(input, fallback = 10) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(n), 25));
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

function normalizeSeverityList(input) {
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

function noteNormalizeExpr(path) {
  // Lowercase + trim. Map empty/null -> "Unspecified".
  return {
    $let: {
      vars: {
        raw: { $trim: { input: { $ifNull: [path, ''] } } }
      },
      in: {
        $cond: [{ $eq: ['$$raw', ''] }, 'Unspecified', { $toLower: '$$raw' }]
      }
    }
  };
}

exports.getMaintenanceRootCauses = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const from = parseDateOrNull(req.query.from);
    const to = parseDateOrNull(req.query.to);
    const limit = parseLimit(req.query.limit, 10);

    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const zoneId = req.query.zoneId ? String(req.query.zoneId) : null;
    const severities = normalizeSeverityList(req.query.severity);

    const needsEqFilter = Boolean(siteId || zoneId);
    const equipmentIds = needsEqFilter ? await resolveEquipmentIds({ tenantId, siteId, zoneId }) : null;
    const tenantObjectId = toObjectId(tenantId) || tenantId;

    const match = {
      tenantId: tenantObjectId,
      kind: 'fault_reported'
    };
    if (equipmentIds?.length) match.equipmentId = { $in: equipmentIds };
    if (from || to) {
      match.occurredAt = {};
      if (from) match.occurredAt.$gte = from;
      if (to) match.occurredAt.$lte = to;
    }
    if (severities?.length) {
      match.severity = { $in: severities };
    }

    const rows = await MaintenanceEvent.aggregate([
      { $match: match },
      {
        $project: {
          noteNorm: noteNormalizeExpr('$note')
        }
      },
      {
        $group: {
          _id: '$noteNorm',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit }
    ]);

    const top = (rows || []).map((r) => ({ label: String(r._id || 'Unspecified'), count: Number(r.count || 0) }));
    const total = top.reduce((s, x) => s + x.count, 0);

    return res.json({
      scope: {
        siteId: siteId || null,
        zoneId: zoneId || null,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        severity: severities
      },
      total,
      top
    });
  } catch (error) {
    console.error('❌ getMaintenanceRootCauses error:', error);
    return res.status(500).json({ message: 'Failed to compute maintenance root causes.' });
  }
};

exports.getComplianceRootCauses = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const from = parseDateOrNull(req.query.from);
    const to = parseDateOrNull(req.query.to);
    const limit = parseLimit(req.query.limit, 10);

    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const zoneId = req.query.zoneId ? String(req.query.zoneId) : null;

    const needsEqFilter = Boolean(siteId || zoneId);
    const equipmentIds = needsEqFilter ? await resolveEquipmentIds({ tenantId, siteId, zoneId }) : null;
    const tenantObjectId = toObjectId(tenantId) || tenantId;

    const match = {
      tenantId: tenantObjectId,
      status: 'Failed',
      reviewStatus: 'final'
    };
    if (equipmentIds?.length) match.equipmentId = { $in: equipmentIds };
    if (from || to) {
      match.inspectionDate = {};
      if (from) match.inspectionDate.$gte = from;
      if (to) match.inspectionDate.$lte = to;
    }

    // Root-cause notes are per failed question result (results[].note).
    const rows = await Inspection.aggregate([
      { $match: match },
      { $unwind: '$results' },
      { $match: { 'results.status': 'Failed' } },
      {
        $project: {
          noteNorm: noteNormalizeExpr('$results.note')
        }
      },
      {
        $group: {
          _id: '$noteNorm',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit }
    ]);

    const top = (rows || []).map((r) => ({ label: String(r._id || 'Unspecified'), count: Number(r.count || 0) }));
    const total = top.reduce((s, x) => s + x.count, 0);

    return res.json({
      scope: {
        siteId: siteId || null,
        zoneId: zoneId || null,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null
      },
      total,
      top
    });
  } catch (error) {
    console.error('❌ getComplianceRootCauses error:', error);
    return res.status(500).json({ message: 'Failed to compute compliance root causes.' });
  }
};
