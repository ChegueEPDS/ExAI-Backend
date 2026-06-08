const mongoose = require('mongoose');
const {
  computeStatusStackedSummary
} = require('../services/operationalSummaryService');
const { getMaterializedSummary } = require('../services/dashboardSummaryService');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
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

    const summary = await getMaterializedSummary({
      kind: 'status-stacked-summary',
      tenantId,
      siteId: siteObjectId,
      zoneId: zoneObjectId,
      loader: () => computeStatusStackedSummary({ tenantId, siteId: siteObjectId, zoneId: zoneObjectId })
    });
    return res.json(summary);
  } catch (error) {
    console.error('❌ getTenantStatusStackedSummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch status summary.' });
  }
};
