const { computeDashboardAnalytics } = require('../services/dashboardAnalyticsService');

function parseDateOrNull(input) {
  if (!input) return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d;
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

    const data = await computeDashboardAnalytics({ tenantId, siteId, zoneId, from, to });
    return res.json(data);
  } catch (error) {
    console.error('❌ getDashboardAnalytics error:', error);
    return res.status(500).json({ message: 'Failed to compute dashboard analytics.' });
  }
};

