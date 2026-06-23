const { shouldAuditRequest, writeAuditLog } = require('../services/auditLogService');

module.exports = function auditMiddleware(req, res, next) {
  if (!shouldAuditRequest(req)) return next();

  res.on('finish', () => {
    writeAuditLog(req, res);
  });

  return next();
};
