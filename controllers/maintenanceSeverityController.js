const { computeMaintenanceSeveritySummary } = require('../services/operationalSummaryService');
const { getOrSet, ttlMsFromEnv } = require('../services/shortTtlCache');

exports.getTenantMaintenanceSeveritySummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const summary = await getOrSet(
      'maintenance-severity-summary',
      JSON.stringify({ tenantId: String(tenantId), scope: 'tenant' }),
      ttlMsFromEnv('MAINTENANCE_SEVERITY_CACHE_TTL_MS', 15 * 1000),
      () => computeMaintenanceSeveritySummary({ tenantId })
    );
    return res.json(summary);
  } catch (error) {
    console.error('❌ getTenantMaintenanceSeveritySummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch maintenance severity summary.' });
  }
};
