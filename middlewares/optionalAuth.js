const jwt = require('jsonwebtoken');

/**
 * Best-effort auth extractor:
 * - If no Bearer token: continue anonymously.
 * - If token invalid/expired: continue anonymously.
 * - If valid: attaches a minimal req.user/req.scope snapshot (no DB lookups).
 */
module.exports = function optionalAuth(req, _res, next) {
  try {
    const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.slice(7).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const subscription = decoded?.subscription || null;
    const plan =
      (subscription && (subscription.plan || subscription.tier)) ||
      decoded?.plan ||
      null;

    const userId = decoded.userId || decoded._id || decoded.sub || null;
    const tenantId = decoded.tenantId || null;
    const tenantType = decoded.tenantType || (subscription && subscription.tenantType) || null;

    req.auth = decoded;
    req.user = {
      id: userId,
      role: decoded.role || null,
      tenantId,
      tenantType,
      plan: plan || null,
      subscription,
    };
    req.userId = userId;
    req.scope = { userId, tenantId, tenantType, plan: plan || null };

    return next();
  } catch {
    return next();
  }
};

