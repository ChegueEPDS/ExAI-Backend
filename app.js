require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const requestIdMiddleware = require('./middlewares/requestIdMiddleware');
const limiter = require('./middlewares/rateLimiter');
const cleanupService = require('./services/cleanupService');
const subscriptionSweeper = require('./services/subscriptionSweeper');
const reportExportCleanup = require('./services/reportExportCleanup');
const systemSettingsStore = require('./services/systemSettingsStore');
const path = require('path');
const fs = require('fs');

// Routes
const authRoutes = require('./routes/authRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const userRoutes = require('./routes/userRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const ocrRoutes = require('./routes/ocrRoutes');
const openaiRoutes = require('./routes/openaiRoutes');
const visionRoutes = require('./routes/visionRoutes');
const fireRoutes = require('./routes/fireRoutes');
const exRegisterRoutes = require('./routes/exRegisterRoutes');
const certificateRoutes = require('./routes/certificateRoutes');
const questionsRoutes = require('./routes/questionsRoutes');
const zoneRoutes = require('./routes/zoneRoutes');
const siteRoutes = require('./routes/siteRoutes');
const graphRoutes = require('./routes/graphRoutes');
const injectionRoutes = require('./routes/injectionRoutes');
const certificateDraftRoutes = require('./routes/certificateDraftRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');
const billingRoutes = require('./routes/billing');
const billingWebhook = require('./routes/billingWebhook');
const upgradeRoutes = require('./routes/upgrade');
const tenantRoutes = require('./routes/tenantRoutes');
const healthMetricsRoutes = require('./routes/healthMetricsRoutes');
const inviteRoutes = require('./routes/inviteRoutes');
const mailRoutes = require('./routes/mailRoutes');
const consentRoutes = require('./routes/consentRoutes');
const certificateRequestRoutes = require('./routes/certificateRequestRoutes');
const inspectionRoutes = require('./routes/inspectionRoutes');
const downloadRoutes = require('./routes/downloadRoutes');
const mobileSyncRoutes = require('./routes/mobileSyncRoutes');
const datasetRoutes = require('./routes/datasetRoutes');
const standardRoutes = require('./routes/standardRoutes');
const mobileSyncWorker = require('./services/mobileSyncWorker');
const statusSummaryRoutes = require('./routes/statusSummaryRoutes');
const rootCauseRoutes = require('./routes/rootCauseRoutes');
const maintenanceSeverityRoutes = require('./routes/maintenanceSeverityRoutes');
const dashboardSettingsRoutes = require('./routes/dashboardSettingsRoutes');
const dashboardAnalyticsRoutes = require('./routes/dashboardAnalyticsRoutes');
const plannedInspectionRoutes = require('./routes/plannedInspectionRoutes');
const systemSettingsRoutes = require('./routes/systemSettingsRoutes');

const app = express();
app.set('trust proxy', 1); // Csak teszt környezetben
const port = process.env.PORT || 3000;
console.log = (...args) => {
  logger.info(args.join(' '));
};
console.warn = (...args) => {
  logger.warn(args.join(' '));
};
console.error = (...args) => {
  logger.error(args.join(' '));
};

connectDB().then(() => console.log('Database connected successfully')).catch((err) => {
  console.error('Database connection failed:', err);
  process.exit(1); // Exit if DB connection fails
});

// Start global system settings loader (DB-backed overrides with code defaults)
systemSettingsStore.start();

function normalizeCorsToken(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // Azure/App Service config values are often pasted with quotes; be tolerant.
  // Examples:
  //   "https://demo.epds.eu"
  //   'https://demo.epds.eu'
  // Keep inner spaces (none expected) but remove wrapping quotes.
  return s.replace(/^['"]+/, '').replace(/['"]+$/, '').trim();
}

const rawCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS
      .split(',')
      .map(normalizeCorsToken)
      .filter(Boolean)
  : [];

// CORS allow list supports:
// - exact origins: "https://certs.atexdb.eu"
// - origin wildcard (scheme + host): "https://*.insp-ex.com"
// - hostname suffix: "*.insp-ex.com" or "insp-ex.com"
const allowedOriginsExact = new Set(
  rawCorsAllowedOrigins.filter((v) => (v.startsWith('http://') || v.startsWith('https://')) && !v.includes('*'))
);

const allowedOriginWildcardRegexes = rawCorsAllowedOrigins
  .filter((v) => (v.startsWith('http://') || v.startsWith('https://')) && v.includes('*'))
  .map((pattern) => {
    // Escape regex chars except '*', then convert '*' to '.*' and anchor.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  });

const allowedHostnameSuffixes = rawCorsAllowedOrigins
  .filter((v) => !(v.startsWith('http://') || v.startsWith('https://')))
  .map((v) => v.replace(/^\*\./, '').replace(/^\./, '').toLowerCase())
  .filter(Boolean);

// Allow local/mobile app origins by default (keeps existing allowlist behavior intact)
const defaultDevOrigins = new Set([
  'http://localhost',
  'http://localhost:8100',
  'http://127.0.0.1',
  'http://127.0.0.1:8100',
  'capacitor://localhost',
  'ionic://localhost'
]);

// Reusable CORS options (applies to REST + SSE)
function isOriginAllowed(origin) {
  // allow same-origin or server-to-server (no origin)
  if (!origin) return true;

  if (allowedOriginsExact.has(origin)) return true;
  if (allowedOriginWildcardRegexes.some((re) => re.test(origin))) return true;
  if (defaultDevOrigins.has(origin)) return true;

  // hostname suffix matching (e.g. "*.insp-ex.com") – allow only over https (except localhost/dev)
  try {
    const u = new URL(origin);
    const host = (u.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    const isHttps = u.protocol === 'https:';
    const okSuffix =
      host && allowedHostnameSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if ((isHttps || isLocalHost) && okSuffix) return true;
  } catch {}

  return false;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0] || '').trim();
  return req.ip || req.connection?.remoteAddress || '';
}

function logCorsDenied(req, origin) {
  logger.error('[cors] Not allowed by CORS', {
    origin: origin || null,
    host: req.headers.host || null,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: getClientIp(req) || null,
    userAgent: req.headers['user-agent'] || null
  });
}

const corsOptionsBase = {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'x-ms-graph-token',
    'x-captcha-token',
    'x-captcha-bypass',
    'x-no-redirect-on-401',
    'x-client',        // mobile vs web client hint
    'x-user-id',        // frontend legacy header (allowed for backwards-compat)
    'x-tenant-id',      // optional explicit tenant header if ever sent
    'x-request-id',     // optional tracing
    'x-client-version'  // optional client versioning
  ],
  // make sure caches/proxies vary on Origin
  preflightContinue: false,
  optionsSuccessStatus: 204
};

const corsDelegate = (req, callback) => {
  const origin = req.header('Origin');
  if (isOriginAllowed(origin)) {
    callback(null, { ...corsOptionsBase, origin: true });
    return;
  }
  logCorsDenied(req, origin);
  // Do NOT throw here: throwing turns into a 500 without CORS headers and the browser surfaces it as a confusing "CORS missing header".
  // Instead, mark the request and let a normal 403 response happen.
  req.corsDenied = true;
  callback(null, { ...corsOptionsBase, origin: false });
};

app.use(cors(corsDelegate));
// Ensure CORS is applied to preflight requests across all routes
app.options('*', cors(corsDelegate));

// Hard block disallowed origins (after CORS evaluation), but with a clean 403 (no stack trace noise).
app.use((req, res, next) => {
  if (req.corsDenied) {
    return res.status(403).json({ ok: false, error: 'Not allowed by CORS' });
  }
  return next();
});

// Request correlation id (used in logs and returned as response header)
app.use(requestIdMiddleware);

// Hint proxies not to buffer (useful for SSE)
app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx
  next();
});

// Fontos: webhook raw body-val, a JSON parser ELŐTT:
app.use('/api', billingWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(limiter);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/results', express.static(path.join(__dirname, 'results')));
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/**
 * SSE-friendly timeout and logging
 * Ensures that for EventSource/fetch streams we don't time out at the socket level,
 * and we can see if the browser navigates away (aborted).
 */
app.use((req, res, next) => {
  const acceptsSSE =
    (req.headers.accept && req.headers.accept.includes('text/event-stream')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('text/event-stream'));

  if (acceptsSSE) {
    // Extra SSE headers for proxy compatibility and to avoid transforms/buffering
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Mark request for downstream handlers (controllers) if needed
    req.isSSE = true;

    if (res.socket && typeof res.socket.setTimeout === 'function') {
      res.socket.setTimeout(0); // disable idle socket timeout for SSE
    }
    req.on('aborted', () => logger.warn('SSE client aborted the connection'));
    req.on('close',   () => logger.warn('SSE connection closed by client'));
    res.on('error',   (err) => logger.error('SSE response stream error', err));
  }
  next();
});

// SSE hardening for the stream endpoints – SKIP for multipart/form-data uploads
app.use((req, res, next) => {
  const ssePaths = new Set([
    '/api/upload-and-ask/stream'
  ]);

  // Ha ez az egyik stream path, de a kérés multipart/form-data -> ne tegyünk SSE header-t itt!
  if (ssePaths.has(req.path)) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const isMultipart = ct.startsWith('multipart/form-data');

    if (!isMultipart) {
      // Csak NEM-multipart esetben tegyünk SSE fejléceket itt
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Vary', 'Origin');

      if (res.socket && typeof res.socket.setTimeout === 'function') {
        res.socket.setTimeout(0);
      }
      if (req.socket && typeof req.socket.setKeepAlive === 'function') {
        req.socket.setKeepAlive(true);
      }

      // FONTOS: multipartnál NE flush-oljunk itt!
      // if (typeof res.flushHeaders === 'function') res.flushHeaders();

      req.isSSE = true;
    }
  }
  next();
});

// (opcionális) explicit OPTIONS a streamre – a globális CORS amúgy is kezeli
app.options('/api/upload-and-ask/stream', cors({ origin: true, credentials: true }));

// Use routes
app.use('/api', authRoutes);
app.use('/api', conversationRoutes);
app.use('/api', statisticsRoutes);
app.use('/api', userRoutes);
app.use('/api', feedbackRoutes);
app.use('/api', ocrRoutes);
app.use('/api', openaiRoutes);
app.use('/api/vision', visionRoutes);
app.use('/api/fire', fireRoutes);
app.use('/api', exRegisterRoutes);
app.use('/api', certificateRoutes);
app.use('/api', certificateDraftRoutes);
app.use('/api/cert-requests', certificateRequestRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api', injectionRoutes);
app.use('/api', notificationsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api', upgradeRoutes);
app.use('/api', tenantRoutes);
app.use('/api', healthMetricsRoutes);
app.use('/api', statusSummaryRoutes);
app.use('/api', rootCauseRoutes);
app.use('/api', maintenanceSeverityRoutes);
app.use('/api', dashboardSettingsRoutes);
app.use('/api', dashboardAnalyticsRoutes);
app.use('/api', plannedInspectionRoutes);
app.use('/api', inviteRoutes);
app.use('/api', mailRoutes);
app.use('/api', consentRoutes);
app.use('/api', inspectionRoutes);
app.use('/api', downloadRoutes);
app.use('/api', mobileSyncRoutes);
app.use('/api', datasetRoutes);
app.use('/api', standardRoutes);
app.use('/api', systemSettingsRoutes);

const backgroundJobsDisabled =
  process.env.DISABLE_BACKGROUND_JOBS === '1' ||
  process.env.DISABLE_BACKGROUND_JOBS === 'true' ||
  process.env.NODE_ENV === 'test';

if (!backgroundJobsDisabled) {
  reportExportCleanup.start();
}


/**
 * -----------------------------
 * Frontend (Angular) static host + SPA fallback
 * -----------------------------
 * Serves files from the compiled Angular 'dist' folder and rewrites
 * all non-API, non-static requests to index.html so deep links like /cert work.
 *
 * You can override the path with FRONTEND_DIST env var if needed.
 */
const frontendDist = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : path.join(__dirname, '..', 'Frontend', 'dist'); // adjust if your dist path differs

if (fs.existsSync(frontendDist)) {
  // Serve static assets
  app.use(express.static(frontendDist));

  // SPA fallback: anything that's not /api or a known static path should return index.html
  app.get('*', (req, res, next) => {
    // Keep API and asset folders untouched
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/uploads') ||
      req.path.startsWith('/results')
    ) {
      return next();
    }
    // If the requested file actually exists, let express.static handle it
    const maybeFile = path.join(frontendDist, req.path);
    if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
      return res.sendFile(maybeFile);
    }
    // Otherwise return index.html for Angular router
    return res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  console.warn('[SPA] Frontend dist folder not found:', frontendDist);
}

if (!backgroundJobsDisabled) {
  // Periodikus tisztítás
  setInterval(cleanupService.removeEmptyConversations, 3 * 60 * 60 * 1000); // 3 órás intervallum
  setInterval(() => cleanupService.cleanupUploadTempFiles(), 3 * 60 * 60 * 1000);
  setInterval(cleanupService.cleanupEquipmentDocsImportErrorReports, 24 * 60 * 60 * 1000); // napi egyszer
  setInterval(subscriptionSweeper.sweepExpiredSubscriptions, 60 * 60 * 1000);
  // Mobile sync background processing (best-effort in-process worker)
  mobileSyncWorker.start({ intervalMs: 5000 });
}

console.log("Starting application...");
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  // Consider graceful shutdown in production
});

// Ensure the server is reachable from other devices on the LAN (mobile testing).
// You can override with HOST env var (e.g. HOST=127.0.0.1 to restrict).
const host = process.env.HOST || '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});

// --- Keep long SSE connections alive and avoid premature timeouts ---
// Never time out HTTP requests (Node's default can cut long streams)
server.requestTimeout = 0;
// Keep the TCP connection alive long enough for proxies (ALB/Nginx) to stay happy
server.keepAliveTimeout = 75_000;
// Must be greater than keepAliveTimeout (Node requirement)
server.headersTimeout = 80_000;
