const jwt = require('jsonwebtoken');

// Autentikációs middleware
const authMiddleware = (roles = []) => {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1]; // A 'Bearer token' formátumból kivesszük a token részt

    // Token ellenőrzése és dekódolása
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Ellenőrizzük, hogy a felhasználó szerepe benne van-e a megengedett szerepekben
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Access denied: Insufficient role' });
      }

      // A felhasználó jogosult, állítsuk be a req.user objektumot
      req.user = {
        id: decoded.userId || decoded._id,
        role: decoded.role,
        company: decoded.company, // A company mező beállítása
        nickname: decoded.nickname // Ha szükséges
      };
        req.userId = decoded.userId || decoded._id; // A tokenből kinyerjük a userId-t
        req.role = decoded.role; // A role-t is elérjük, ha szükséges
        next();
    });
  };
};

module.exports = authMiddleware;
