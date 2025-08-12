const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

module.exports = function authSseFromQueryOrHeader() {
  return (req, res, next) => {
    try {
      // 1) Header (Authorization: Bearer <token>)
      let token = null;
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) token = auth.substring(7).trim();

      // 2) Ha nincs, próbáld query-ből (?token=...)
      if (!token && req.query && req.query.token) token = String(req.query.token);

      if (!token) return res.status(401).json({ error: 'Unauthorized (no token)' });

      const decoded = jwt.verify(token, JWT_SECRET);
      req.userId = decoded.userId;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized (bad token)' });
    }
  };
}