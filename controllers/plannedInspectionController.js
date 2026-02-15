const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');

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

    const query = {
      tenantId,
      isProcessed: true,
      lastInspectionStatus: 'Passed',
      lastInspectionValidUntil: { $ne: null }
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
      query.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
    }

    const rows = await Equipment.find(query)
      .select('_id EqID TagNo lastInspectionValidUntil Site Unit Zone')
      .populate({ path: 'Site', select: 'Name', options: { lean: true } })
      .populate({ path: 'Unit', select: 'Name', options: { lean: true } })
      .populate({ path: 'Zone', select: 'Name', options: { lean: true } })
      .sort({ lastInspectionValidUntil: 1, _id: 1 })
      .limit(limit)
      .lean();

    const now = Date.now();
    const items = (rows || []).map((r) => {
      const dueAt = r.lastInspectionValidUntil ? new Date(r.lastInspectionValidUntil) : null;
      const dueMs = dueAt ? dueAt.getTime() : null;
      return {
        equipmentId: String(r._id),
        eqId: r.EqID || null,
        tagNo: r.TagNo || null,
        dueAt,
        pastDue: dueMs != null ? now > dueMs : false,
        siteName: r.Site?.Name || null,
        zoneName: r.Unit?.Name || r.Zone?.Name || null
      };
    });

    return res.json({
      scope: { scope, siteId: scope === 'global' ? null : String(siteId || ''), zoneId: scope === 'zone' ? String(zoneId || '') : null },
      limit,
      items
    });
  } catch (err) {
    console.error('getPlannedInspections failed:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
