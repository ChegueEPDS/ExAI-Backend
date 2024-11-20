const jwt = require('jsonwebtoken');

// Autentikációs middleware
const authMiddleware = (roles = []) => {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1]; // "Bearer token" formátumból kivesszük a token részt

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Ellenőrizzük, hogy a felhasználó szerepe megfelelő-e
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Access denied: Insufficient role' });
      }

      // Jogosultság ellenőrzése után hozzáadjuk a felhasználói adatokat a kéréshez
      req.userId = decoded.userId;
      req.role = decoded.role;
      next();
    });
  };
};

module.exports = authMiddleware;
