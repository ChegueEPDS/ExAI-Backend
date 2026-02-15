const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const { computeOperationalSummary, computeOverallStatusSummary } = require('../services/operationalSummaryService');
const Unit = require('../models/unit');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function computeComplianceStatusSummary({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const match = { tenantId: tenantObjectId };
  if (siteId) match.Site = siteId;
  if (zoneId) {
    const unitIds = await Unit.find({
      tenantId: tenantObjectId,
      $or: [{ _id: zoneId }, { ancestors: zoneId }]
    }).select('_id').lean();
    const ids = unitIds.map(u => u._id);
    match.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
  }

  const rows = await Equipment.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$Compliance',
        count: { $sum: 1 }
      }
    }
  ]);

  const counts = { passed: 0, failed: 0, na: 0 };
  for (const r of rows || []) {
    const k = String(r?._id || 'NA');
    const n = Number(r?.count || 0);
    if (k === 'Passed') counts.passed += n;
    else if (k === 'Failed') counts.failed += n;
    else counts.na += n;
  }

  return { total: counts.passed + counts.failed + counts.na, counts };
}

exports.getTenantStatusStackedSummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const siteId = req.query?.siteId || null;
    const zoneId = req.query?.zoneId || null;

    const siteObjectId = siteId ? toObjectId(siteId) : null;
    const zoneObjectId = zoneId ? toObjectId(zoneId) : null;
    if (siteId && !siteObjectId) return res.status(400).json({ message: 'Invalid siteId.' });
    if (zoneId && !zoneObjectId) return res.status(400).json({ message: 'Invalid zoneId.' });

    const [maintenance, compliance, overall] = await Promise.all([
      computeOperationalSummary({ tenantId, siteId: siteObjectId, zoneId: zoneObjectId }),
      computeComplianceStatusSummary({ tenantId, siteId: siteObjectId, zoneId: zoneObjectId }),
      computeOverallStatusSummary({ tenantId, siteId: siteObjectId, zoneId: zoneObjectId })
    ]);

    return res.json({
      maintenance,
      compliance,
      overall
    });
  } catch (error) {
    console.error('❌ getTenantStatusStackedSummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch status summary.' });
  }
};
