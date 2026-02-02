const crypto = require('crypto');

function createRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

module.exports = function requestIdMiddleware(req, res, next) {
  const header = req.headers['x-request-id'];
  const incoming = Array.isArray(header) ? header[0] : header;
  const requestId = String(incoming || '').trim() || createRequestId();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  return next();
};

