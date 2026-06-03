const Tenant = require('../models/tenant');

function isFeatureEnabled(tenant, featureName) {
  if (!tenant) return false;
  if (String(tenant.type || '').toLowerCase() === 'personal') return false;
  const features = tenant.features || {};
  if (!Object.prototype.hasOwnProperty.call(features, featureName)) return false;
  const value = features[featureName];
  return value !== false;
}

function requireTenantFeature(featureName) {
  return async (req, res, next) => {
    try {
      const tenantId = req.scope?.tenantId || req.user?.tenantId || null;
      if (!tenantId) {
        return res.status(403).json({ error: 'Missing tenant context' });
      }

      const tenant = await Tenant.findById(tenantId).select('type features').lean();
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      if (!isFeatureEnabled(tenant, featureName)) {
        return res.status(403).json({
          error: 'Tenant feature disabled',
          feature: featureName
        });
      }

      next();
    } catch (err) {
      console.error('[tenant-feature] error', err);
      return res.status(500).json({ error: 'Feature check failed' });
    }
  };
}

module.exports = {
  requireTenantFeature,
  isFeatureEnabled
};
