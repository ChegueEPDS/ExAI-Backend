// middlewares/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Általános limiter – minden API-ra (kivéve SSE/multipart upload stream és login)
const generalLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 perc
  max: 1000,                // Max 1000 kérés / IP / 30 perc
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
