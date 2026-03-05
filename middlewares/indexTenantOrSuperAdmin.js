// middlewares/indexTenantOrSuperAdmin.js
/**
 * Allow access if:
 * - requester is on Index tenant (tenantName: 'index' or 'ind-ex'), regardless of role
 * - OR requester is SuperAdmin (any tenant)
 *
 * Requires authMiddleware() to have populated req.scope.
 */
module.exports = function requireIndexTenantOrSuperAdmin(req, res, next) {
  const tenantName = (req.scope?.tenantName || '').toString().trim().toLowerCase();
  const role = (req.user?.role || req.role || '').toString();
  const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';
  const isSuperAdmin = /superadmin/i.test(role);

  if (isIndexTenant || isSuperAdmin) return next();
  return res.status(403).json({ ok: false, error: 'Access denied' });
};
