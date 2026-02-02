const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const { computeOperationalSummary, computeOverallStatusSummary } = require('../services/operationalSummaryService');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function computeComplianceStatusSummary({ tenantId }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const rows = await Equipment.aggregate([
    { $match: { tenantId: tenantObjectId } },
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

    const [maintenance, compliance, overall] = await Promise.all([
      computeOperationalSummary({ tenantId }),
      computeComplianceStatusSummary({ tenantId }),
      computeOverallStatusSummary({ tenantId })
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

