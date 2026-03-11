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
  // Be resilient to role casing/spacing and to different auth middleware shapes.
  const roleRaw = [
    req.user?.role,
    req.role,
    req.auth?.role,
    req.scope?.role,
    req.scope?.userRole
  ]
    .filter(Boolean)
    .map((v) => String(v))
    .join(' ');
  const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';
  const isSuperAdmin = /super\s*admin/i.test(roleRaw);

  if (isIndexTenant || isSuperAdmin) return next();
  return res.status(403).json({ ok: false, error: 'Access denied' });
};
