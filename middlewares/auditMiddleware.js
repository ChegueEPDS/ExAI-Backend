const { shouldAuditResponse, writeAuditLog } = require('../services/auditLogService');

module.exports = function auditMiddleware(req, res, next) {
  const originalJson = res.json;
  res.json = function auditJson(body) {
    if (Number(res.statusCode) >= 500 && body && typeof body === 'object') {
      const message = body.error || body.message;
      if (message) {
        req.auditResponseError = String(message).slice(0, 1000);
      }
    }
    return originalJson.call(this, body);
  };

  res.on('finish', () => {
    if (req.auditErrorLogged) return;
    if (shouldAuditResponse(req, res.statusCode)) {
      writeAuditLog(req, res, req.auditError ? {
        action: 'server.httpError',
        resourceType: 'server-error',
        error: req.auditError,
      } : {
        action: Number(res.statusCode) >= 500 ? 'server.httpError' : undefined,
        resourceType: Number(res.statusCode) >= 500 ? 'server-error' : undefined,
        metadata: req.auditResponseError ? { responseError: req.auditResponseError } : undefined,
      });
    }
  });

  return next();
};
