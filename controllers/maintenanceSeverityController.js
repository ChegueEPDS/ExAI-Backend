const { computeMaintenanceSeveritySummary } = require('../services/operationalSummaryService');
const { getMaterializedSummary } = require('../services/dashboardSummaryService');

exports.getTenantMaintenanceSeveritySummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const summary = await getMaterializedSummary({
      kind: 'maintenance-severity-summary',
      tenantId,
      loader: () => computeMaintenanceSeveritySummary({ tenantId })
    });
    return res.json(summary);
  } catch (error) {
    console.error('❌ getTenantMaintenanceSeveritySummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch maintenance severity summary.' });
  }
};
