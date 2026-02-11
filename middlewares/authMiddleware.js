// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const { computePermissions, getEffectiveProfessions } = require('../helpers/rbac');

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
      const authHeader = req.headers['authorization'] || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const token = authHeader.slice(7).trim();
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Szerepkör ellenőrzés (ha szükséges)
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Access denied: Insufficient role' });
      }

      const decodedUserId = decoded.userId || decoded._id || decoded.sub;
      let userDoc = null;

      // Tenant ID kötelező – ha hiányzik a régi tokenből, töltsük DB-ből
      let tenantId = decoded.tenantId;
      if (!tenantId) {
        userDoc =
          userDoc ||
          (await User.findById(decodedUserId).select('tenantId role nickname professions').lean());
        if (!userDoc || !userDoc.tenantId) return res.status(403).json({ error: 'No tenant assigned' });
        tenantId = String(userDoc.tenantId);
      }

      // Professions: from token (v3+) or from DB fallback
      let professions = decoded.professions;
      if (!Array.isArray(professions)) {
        userDoc =
          userDoc ||
          (await User.findById(decodedUserId).select('tenantId role nickname professions').lean());
        professions = userDoc?.professions || undefined;
      }

      // Tenant meta (név, típus): tokenből, ha nincs akkor betöltjük
      let tenantName = decoded.tenantName || null;
      let tenantType = decoded.tenantType || null; // 'company' | 'personal' | stb.
      let professionRbacEnabled =
        typeof decoded.professionRbacEnabled === 'boolean' ? decoded.professionRbacEnabled : null;

      if (!tenantName || !tenantType || professionRbacEnabled === null) {
        try {
          const t = await Tenant.findById(tenantId).select('name type professionRbacEnabled').lean();
          if (t) {
            tenantName = tenantName || t.name || null;
            tenantType = tenantType || t.type || null;
            if (professionRbacEnabled === null) {
              professionRbacEnabled = Boolean(t.professionRbacEnabled);
            }
          }
        } catch (_) {
          // swallow – nem blokkoljuk, csak meta hiányzik
        }
      }
      if (professionRbacEnabled === null) professionRbacEnabled = false;

      const effectiveProfessions = professionRbacEnabled
        ? getEffectiveProfessions({ role: decoded.role, professions })
        : ['manager'];
      const permissions = professionRbacEnabled
        ? computePermissions({ role: decoded.role, professions: effectiveProfessions })
        : ['*:*'];

      // --- Attach full decoded JWT and normalize subscription/plan snapshot ---
      req.auth = decoded;
      const subscriptionSnap = decoded.subscription || null;
      const planFromToken =
        (subscriptionSnap && (subscriptionSnap.plan || subscriptionSnap.tier)) ||
        decoded.plan ||
        null;

      // Keep these on req.auth for convenience, too
      req.auth.subscription = subscriptionSnap || null;
      req.auth.plan = planFromToken;

      // egységes user objektum (company kivezetve – csak akkor adjuk vissza, ha a token tartalmazta)
      req.user = {
        id: decodedUserId,
        role: decoded.role,
        nickname: decoded.nickname || null,
        azureId: decoded.azureId || null,
        tenantId,
        tenantName,
        tenantType,
        professionRbacEnabled: Boolean(professionRbacEnabled),
        professions: effectiveProfessions,
        permissions,
        tokenType: decoded.type || 'access',
        // normalized subscription snapshot from JWT (if present)
        subscription: subscriptionSnap || null,
        // convenience: derived plan from subscription snapshot (plan or tier)
        plan: planFromToken || undefined,
        // backward-compat: ha régi token tartalmazta, átadjuk, de az új kódban ne használd már
        company: Object.prototype.hasOwnProperty.call(decoded, 'company') ? decoded.company : undefined,
      };

      // Backward-compat convenience
      req.userId = req.user.id;
      req.role = req.user.role;
      req.azureId = req.user.azureId || null;
      // Figyelem: company kivezetve – csak akkor létezik, ha a tokenben volt
      req.company = req.user.company;

      // Egységes szkóp (új)
      req.scope = {
        userId: req.user.id,
        tenantId,
        tenantName,
        tenantType,
        professionRbacEnabled: Boolean(professionRbacEnabled),
        // expose plan so downstream controllers can quickly check entitlements
        plan: planFromToken || null,
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
