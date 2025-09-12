// middlewares/authSse.js
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

module.exports = function authSseFromQueryOrHeader() {
  return async (req, res, next) => {
    try {
      let token = null;

      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) token = auth.substring(7).trim();

      if (!token && req.query && req.query.token) token = String(req.query.token);

      if (!token) return res.status(401).json({ error: 'Unauthorized (no token)' });

      const decoded = jwt.verify(token, JWT_SECRET);

      // (opcionális) csak SSE token engedélyezése:
      // if (decoded.type && decoded.type !== 'sse') {
      //   return res.status(401).json({ error: 'Unauthorized (wrong token type)' });
      // }

      // Fallback tenantId betöltés
      let tenantId = decoded.tenantId;
      if (!tenantId) {
        const u = await User.findById(decoded.userId || decoded._id).select('tenantId').lean();
        if (!u || !u.tenantId) return res.status(403).json({ error: 'No tenant assigned' });
        tenantId = String(u.tenantId);
      }

      req.user = {
        id: decoded.userId || decoded._id || decoded.sub,
        role: decoded.role,
        tenantId,
        tokenType: decoded.type || 'sse',
      };
      req.userId = req.user.id;
      req.scope = { tenantId, userId: req.user.id };

      next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized (bad token)' });
    }
  };
}