const { computePermissions, hasAnyPermission } = require('../helpers/rbac');

/**
 * requirePermission(required: string|string[])
 * Expects authMiddleware to have populated req.user.
 */
function requirePermission(required) {
  const requiredList = Array.isArray(required) ? required : [required];

  return (req, res, next) => {
    // Feature flag: when profession RBAC is disabled for the tenant, do not enforce permissions.
    if (req?.scope && req.scope.professionRbacEnabled === false) {
      return next();
    }

    const user = req.user || {};
    const perms =
      Array.isArray(user.permissions) && user.permissions.length
        ? user.permissions
        : computePermissions({ role: user.role, professions: user.professions });

    if (!hasAnyPermission(perms, requiredList)) {
      return res.status(403).json({
        error: 'Access denied: insufficient permissions',
        required: requiredList,
      });
    }

    return next();
  };
}

module.exports = { requirePermission };
