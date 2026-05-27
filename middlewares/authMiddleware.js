// middlewares/authMiddleware.js
const {
  authenticateAccessToken,
  getAccessTokenFromRequest,
  validateCsrf,
} = require('../services/authSessionService');

/**
 * authMiddleware(roles?: string[])
 * - Ellenőrzi a JWT-t, opcionálisan szerepkört is
 * - Beállítja: req.user, req.userId, req.role, req.scope
 * - Tenant adatok: tenantId kötelező (legacy tokennél DB-ből pótoljuk)
 * - Tenant meta (név, típus): tokenből, vagy ha hiányzik, egyszer lekérdezéssel
 */
const authMiddleware = (roles = []) => {
  return async (req, res, next) => {
    try {
      const { token, source } = getAccessTokenFromRequest(req);
      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }
      if (!validateCsrf(req, source)) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }

      const { decoded, session, user } = await authenticateAccessToken(token);

      // Szerepkör ellenőrzés (ha szükséges)
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'Access denied: Insufficient role' });
      }

      // --- Attach full decoded JWT and normalize subscription/plan snapshot ---
      req.auth = decoded;
      req.auth.subscription = user.subscription || null;
      req.auth.plan = user.plan || null;
      req.auth.sessionId = String(session._id);

      req.user = { ...user, tokenType: 'access' };

      // Backward-compat convenience
      req.userId = req.user.id;
      req.role = req.user.role;
      req.azureId = req.user.azureId || null;
      // Figyelem: company kivezetve – csak akkor létezik, ha a tokenben volt
      req.company = req.user.company;

      // Egységes szkóp (új)
      req.scope = {
        userId: req.user.id,
        tenantId: req.user.tenantId,
        tenantName: req.user.tenantName,
        tenantType: req.user.tenantType,
        professionRbacEnabled: Boolean(req.user.professionRbacEnabled),
        // expose plan so downstream controllers can quickly check entitlements
        plan: req.user.plan || null,
        sessionId: String(session._id),
      };

      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
};

// Basic requireAuth middleware (no role restriction)
const requireAuth = authMiddleware();

// Role-based guard factory
const requireRole = (role) => {
  return authMiddleware([role]);
};

// Backward-compatible exports:
// - const authMiddleware = require('../middlewares/authMiddleware');            // default function
// - const { authMiddleware, requireAuth, requireRole } = require('../middlewares/authMiddleware'); // named
module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.requireAuth = requireAuth;
module.exports.requireRole = requireRole;
