const multer = require('multer');
const logger = require('../config/logger');

function statusFromError(err) {
  const explicit = Number(err?.status || err?.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return 413;
    }
    return 400;
  }
  return 500;
}

function publicMessage(err, statusCode) {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return 'Uploaded file is too large.';
      case 'LIMIT_FILE_COUNT':
        return 'Too many files uploaded.';
      case 'LIMIT_FIELD_COUNT':
        return 'Too many form fields.';
      case 'LIMIT_PART_COUNT':
        return 'Multipart request has too many parts.';
      case 'LIMIT_UNEXPECTED_FILE':
        return 'Unexpected upload field.';
      default:
        return 'Upload failed.';
    }
  }
  if (statusCode < 500 && err?.message) return String(err.message);
  return 'Internal server error';
}

module.exports = function apiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const isApiRequest = String(req.originalUrl || req.url || '').startsWith('/api');
  if (!isApiRequest) return next(err);

  const statusCode = statusFromError(err);
  const body = {
    ok: false,
    error: publicMessage(err, statusCode),
    requestId: req.requestId || null,
  };

  if (err instanceof multer.MulterError) {
    body.code = err.code;
    if (err.field) body.field = err.field;
  }

  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    body.stack = String(err.stack).split('\n').slice(0, 8);
  }

  logger.error('api.error', {
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl || req.url,
    statusCode,
    error: err?.message || String(err),
    code: err?.code,
  });

  return res.status(statusCode).json(body);
};
