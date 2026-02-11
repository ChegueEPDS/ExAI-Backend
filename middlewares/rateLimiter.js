// middlewares/rateLimiter.js
const rateLimit = require('express-rate-limit');

function normalizeClientIp(input) {
  let s = String(input || '').trim();
  if (!s) return '';

  // x-forwarded-for may be a list
  if (s.includes(',')) s = s.split(',')[0].trim();

  // "[::1]:1234" -> "::1"
  const bracketed = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) return bracketed[1].trim();

  // "1.2.3.4:1234" -> "1.2.3.4" (but keep plain IPv6 which has multiple ':')
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount === 1 && s.includes('.')) {
    return s.split(':')[0].trim();
  }

  return s;
}

function keyGenerator(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = (typeof xff === 'string' && xff.trim())
    ? xff
    : (Array.isArray(xff) && xff.length ? String(xff[0] || '') : (req.ip || req.connection?.remoteAddress || ''));
  return normalizeClientIp(raw) || 'unknown';
}

// Általános limiter – minden API-ra (kivéve SSE/multipart upload stream és login)
const generalLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 perc
  max: 1000,                // Max 1000 kérés / IP / 30 perc
  keyGenerator,
  handler: (req, res) => {
    res.status(429).json({
      status: 'error',
      message: 'Túl sok kérés érkezett. Kérjük, próbálkozz újra később.'
    });
  }
});

// Szigorú limiter – csak login / auth végpontokra
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 perc
  max: 20,                  // Max 20 próbálkozás / IP / 15 perc
  keyGenerator,
  handler: (req, res) => {
    res.status(429).json({
      status: 'error',
      message: 'Túl sok bejelentkezési kísérlet. Próbáld újra 15 perc múlva.'
    });
  }
});

// Feltöltős SSE végpontok (multipart + stream)
const sseUploadPaths = new Set([
  '/api/upload-and-ask/stream'
]);

module.exports = (req, res, next) => {
  // SSE kivételek
  if (
    req.path === '/api/notifications/stream' ||
    req.path === '/api/upload-and-ask/stream'            // <-- ÚJ
  ) {
    return next();
  }

  // ÚJ: multipart feltöltős SSE végpontoknál NE limitáljunk
  if (sseUploadPaths.has(req.path)) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const isMultipart = ct.startsWith('multipart/form-data');
    if (isMultipart) {
      return next();
    }
    // ha valaki nem multiparttal lövi, sima limiter mehet rá
  }

  // Login / auth végpontokra a szigorú limiter
  if (
    req.path === '/api/login' ||
    /^\/api\/auth\//i.test(req.path)
  ) {
    return loginLimiter(req, res, next);
  }

  // Minden másra az általános limiter
  return generalLimiter(req, res, next);
};
