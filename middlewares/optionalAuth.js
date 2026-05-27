const {
  authenticateAccessToken,
  getAccessTokenFromRequest,
} = require('../services/authSessionService');

/**
 * Best-effort auth extractor:
 * - If no Bearer token: continue anonymously.
 * - If token invalid/expired: continue anonymously.
 * - If valid: attaches a minimal req.user/req.scope snapshot (no DB lookups).
 */
module.exports = async function optionalAuth(req, _res, next) {
  try {
    const { token } = getAccessTokenFromRequest(req);
    if (!token) {
      return next();
    }

    const { decoded, user } = await authenticateAccessToken(token);

    req.auth = decoded;
    req.user = user;
    req.userId = user.id;
    req.scope = {
      userId: user.id,
      tenantId: user.tenantId,
      tenantType: user.tenantType,
      plan: user.plan || null,
    };

    return next();
  } catch {
    return next();
  }
};
