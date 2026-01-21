// middlewares/captchaMiddleware.js
const axios = require('axios');
const logger = require('../config/logger');

const SECRET = process.env.RECAPTCHA_SECRET;
const MIN_SCORE = parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5');
const BYPASS_KEY = process.env.RECAPTCHA_BYPASS_KEY || process.env.CAPTCHA_BYPASS_KEY || null;
const BYPASS_ENABLED =
  process.env.RECAPTCHA_BYPASS_ENABLED === '1' ||
  process.env.RECAPTCHA_BYPASS_ENABLED === 'true' ||
  process.env.CAPTCHA_BYPASS_ENABLED === '1' ||
  process.env.CAPTCHA_BYPASS_ENABLED === 'true' ||
  process.env.NODE_ENV === 'development' ||
  process.env.NODE_ENV === 'test';
const DISABLED =
  process.env.RECAPTCHA_DISABLED === '1' ||
  process.env.RECAPTCHA_DISABLED === 'true' ||
  process.env.CAPTCHA_DISABLED === '1' ||
  process.env.CAPTCHA_DISABLED === 'true';
const BYPASS_HEADER = (process.env.RECAPTCHA_BYPASS_HEADER || 'x-captcha-bypass').toLowerCase();

function log(level, msg) {
  try {
    if (logger && typeof logger[level] === 'function') {
      logger[level](msg);
    } else if (console && typeof console[level] === 'function') {
      console[level](msg);
    } else {
      console.log(msg);
    }
    if (process.env.RECAPTCHA_TRACE_STDOUT === '1') {
      process.stdout.write(String(msg) + '\n');
    }
  } catch {
    try { console.log(msg); } catch {}
  }
}

/**
 * reCAPTCHA v3 verification middleware
 * Accepts tokens from multiple common locations/keys to be flexible with different frontends:
 *   - req.body.recaptchaToken        ✅ (preferred; matches current Angular frontend)
 *   - req.body.captchaToken
 *   - req.body['g-recaptcha-response']
 *   - req.headers['x-captcha-token']
 *   - req.query.recaptchaToken
 *
 * Optionally accepts an action hint (v3):
 *   - req.body.captchaAction or req.body.action
 *
 * On success, attaches verification info to req.captcha = { score, hostname, action }.
 */
async function captchaVerify(req, res, next) {
  try {
    log('info', `[reCAPTCHA] Incoming request path: ${req.path}, IP: ${req.ip}`);

    if (DISABLED) {
      req.captcha = { bypassed: true, reason: 'disabled' };
      log('warn', '[reCAPTCHA] Bypassed (disabled by env).');
      return next();
    }

    const bypassValue = req.headers?.[BYPASS_HEADER] || null;
    if (BYPASS_ENABLED && BYPASS_KEY && bypassValue && String(bypassValue) === String(BYPASS_KEY)) {
      req.captcha = { bypassed: true, reason: 'header-bypass' };
      log('warn', '[reCAPTCHA] Bypassed (header key match).');
      return next();
    }

    // Accept token from body, headers, or query
    const token =
      (req.body &&
        (req.body.recaptchaToken ||
         req.body.captchaToken ||
         req.body['g-recaptcha-response'])) ||
      req.headers['x-captcha-token'] ||
      (req.query && (req.query.recaptchaToken || req.query.captchaToken));

    log('info', `[reCAPTCHA] Token received: ${token ? 'Yes' : 'No'}`);

    // Optional action (v3)
    const expectedAction =
      (req.body && (req.body.captchaAction || req.body.action)) ||
      (req.query && (req.query.captchaAction || req.query.action)) ||
      null;

    if (!SECRET) {
      log('error', '[reCAPTCHA] Captcha secret not configured.');
      return res.status(500).json({ error: 'Captcha secret not configured.' });
    }

    if (!token) {
      log('warn', '[reCAPTCHA] Captcha token missing.');
      return res.status(400).json({ error: 'Captcha token missing.' });
    }

    // Verify with Google
    const resp = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      null,
      {
        params: { secret: SECRET, response: token },
        timeout: 6000
      }
    );

    const data = resp.data || {};
    log('info', `[reCAPTCHA] Verification response: success=${data.success}, score=${data.score}, hostname=${data.hostname}, action=${data.action}`);

    // Expected success flag
    if (!data.success) {
      log('warn', '[reCAPTCHA] Captcha verification failed.');
      return res.status(403).json({ error: 'Captcha verification failed.' });
    }

    // v3: score threshold (if present)
    if (typeof data.score === 'number' && data.score < MIN_SCORE) {
      log('warn', `[reCAPTCHA] Captcha score too low: ${data.score}`);
      return res.status(403).json({ error: 'Captcha score too low.', score: data.score });
    }

    // v3: optional action match (if both sides set it)
    if (expectedAction && data.action && expectedAction !== data.action) {
      log('warn', `[reCAPTCHA] Captcha action mismatch: expected=${expectedAction} got=${data.action}`);
      return res.status(403).json({ error: 'Captcha action mismatch.', expected: expectedAction, got: data.action });
    }

    // Attach metadata for logging/auditing
    req.captcha = {
      score: typeof data.score === 'number' ? data.score : null,
      hostname: data.hostname || null,
      action: data.action || null,
      challenge_ts: data.challenge_ts || null
    };

    log('info', `[reCAPTCHA] Captcha verification succeeded: score=${req.captcha.score}, hostname=${req.captcha.hostname}`);

    return next();
  } catch (err) {
    // Surface useful info but avoid leaking secrets
    const payload = err?.response?.data || err.message || String(err);
    log('error', `[reCAPTCHA] verify error: ${typeof payload === 'object' ? JSON.stringify(payload) : payload}`);
    return res.status(500).json({ error: 'Captcha verification failed (internal).' });
  }
}

module.exports = captchaVerify;
