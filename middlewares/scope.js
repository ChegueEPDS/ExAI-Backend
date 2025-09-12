 // middlewares/scope.js
module.exports = function scope() {
  return (req, res, next) => {
    if (!req.user?.tenantId) {
      return res.status(403).json({ error: 'No tenant assigned' });
    }
    // Már az auth beállította, itt csak ellenőrzünk
    req.scope = req.scope || { tenantId: req.user.tenantId, userId: req.user.id };
    next();
  };
};