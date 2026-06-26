const { writeAuditLog } = require('../services/auditLogService');

module.exports = function errorAuditMiddleware(err, req, res, next) {
  req.auditError = err;
  req.auditErrorLogged = true;

  writeAuditLog(req, res, {
    action: 'server.exception',
    resourceType: 'server-error',
    statusCode: err?.status || err?.statusCode || 500,
    success: false,
    error: err,
  });

  return next(err);
};
