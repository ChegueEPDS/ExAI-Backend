// middlewares/authSse.js
const {
  authenticateAccessToken,
  getAccessTokenFromRequest,
} = require('../services/authSessionService');

module.exports = function authSseFromQueryOrHeader() {
  return async (req, res, next) => {
    try {
      let { token } = getAccessTokenFromRequest(req);

      if (!token) return res.status(401).json({ error: 'Unauthorized (no token)' });

      const { user } = await authenticateAccessToken(token);

      req.user = {
        ...user,
        tokenType: 'access',
      };
      req.userId = req.user.id;
      req.scope = { tenantId: user.tenantId, userId: req.user.id };

      next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized (bad token)' });
    }
  };
}
