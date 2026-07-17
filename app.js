require('dotenv').config();
const util = require('util');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const logger = require('./config/logger');

if (process.env.WORKER_ONLY === '1' || process.env.WORKER_ONLY === 'true') {
  logger.error('WORKER_ONLY=true is set, but app.js was started. Use `npm run start:worker` for the worker App Service.');
  process.exit(1);
}

const requestIdMiddleware = require('./middlewares/requestIdMiddleware');
const auditMiddleware = require('./middlewares/auditMiddleware');
const errorAuditMiddleware = require('./middlewares/errorAuditMiddleware');
const apiErrorHandler = require('./middlewares/apiErrorHandler');
const limiter = require('./middlewares/rateLimiter');
const systemSettingsStore = require('./services/systemSettingsStore');
const { writeSystemAuditLog } = require('./services/auditLogService');
const { seedInitialSuperAdminIfEmpty } = require('./services/bootstrapSuperAdmin');
const { seedRbQuestionsIfEmpty } = require('./services/rbQuestionSeedService');
const { backgroundJobsDisabled, startWorkerRuntime, stopWorkerRuntime } = require('./services/workerRuntime');
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
const consentRoutes = require('./routes/consentRoutes');
const certificateRequestRoutes = require('./routes/certificateRequestRoutes');
const inspectionRoutes = require('./routes/inspectionRoutes');
const downloadRoutes = require('./routes/downloadRoutes');
const mobileSyncRoutes = require('./routes/mobileSyncRoutes');
const statusSummaryRoutes = require('./routes/statusSummaryRoutes');
const rootCauseRoutes = require('./routes/rootCauseRoutes');
const maintenanceSeverityRoutes = require('./routes/maintenanceSeverityRoutes');
const dashboardSettingsRoutes = require('./routes/dashboardSettingsRoutes');
const dashboardAnalyticsRoutes = require('./routes/dashboardAnalyticsRoutes');
const plannedInspectionRoutes = require('./routes/plannedInspectionRoutes');
const systemSettingsRoutes = require('./routes/systemSettingsRoutes');
const tenantSettingsRoutes = require('./routes/tenantSettingsRoutes');
const manufacturerRoutes = require('./routes/manufacturerRoutes');
const equipmentConflictRoutes = require('./routes/equipmentConflictRoutes');
const trainingRoutes = require('./routes/trainingRoutes');
const publicRotRoutes = require('./routes/publicRotRoutes');
const customFieldRoutes = require('./routes/customFieldRoutes');
const schemaRoutes = require('./routes/schemaRoutes');
const navigationRoutes = require('./routes/navigationRoutes');
const tenantAccessRoutes = require('./routes/tenantAccessRoutes');
const auditRoutes = require('./routes/auditRoutes');
const documentationRoutes = require('./routes/documentationRoutes');

const app = express();
app.set('trust proxy', 1); // Csak teszt környezetben
const port = process.env.PORT || 3000;
const runtimeState = {
  initialized: false,
  settingsReady: false,
  workerStarted: false,
  shuttingDown: false,
};
let server = null;
const openSockets = new Set();
const sseResponses = new Set();

function formatConsoleArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatConsoleArgs(args) {
  if (typeof args[0] === 'string') {
    return util.formatWithOptions({ depth: 5, colors: false }, ...args);
  }
  return args.map(formatConsoleArg).join(' ');
}

console.log = (...args) => {
  logger.info(formatConsoleArgs(args));
};
console.warn = (...args) => {
  logger.warn(formatConsoleArgs(args));
};
console.error = (...args) => {
  logger.error(formatConsoleArgs(args));
};

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
  'https://localhost',
  'http://localhost:8100',
  'http://localhost:8080',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://127.0.0.1:8100',
  'http://127.0.0.1:8080',
  'capacitor://localhost',
  'ionic://localhost',
  // Some WebViews (and file:// contexts) send Origin: null, which would otherwise be blocked and surfaces as status=0 "Unknown Error"
  'null'
]);

// Reusable CORS options (applies to REST + SSE)
function isOriginAllowed(origin) {
  // allow same-origin or server-to-server (no origin)
  if (!origin) return true;
  // Some clients send literal "null" (string) as Origin; treat it like no-origin for mobile/webview compatibility.
  if (origin === 'null') return true;

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
    'x-csrf-token',
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

const NORMAL_REQUEST_TIMEOUT_MS = Math.max(30_000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 120_000));
const LONG_REQUEST_TIMEOUT_MS = Math.max(10 * 60_000, Number(process.env.HTTP_LONG_REQUEST_TIMEOUT_MS || 2 * 60 * 60_000));
const UNLIMITED_TIMEOUT_PATHS = [
  /^\/api\/exreg\/import-documents-zip(?:\/|$)/,
  /^\/api\/notifications\/stream(?:\/|$)/,
  /^\/api\/chat\/stream(?:\/|$)/,
  /^\/api\/upload-and-ask\/stream(?:\/|$)/,
];
const LONG_TIMEOUT_PATHS = [
  /^\/api\/exreg\/(?:import|import-xlsx|export|export-xlsx|export-ui-xlsx)(?:\/|$)/,
  /^\/api\/exreg\/certificate-summary(?:-compact)?(?:\/|$)/,
  /^\/api\/mobile\/sync(?:\/|$)/,
  /^\/api\/certificates\/(?:bulk-upload|drafts\/process|drafts\/reprocess|drafts\/finalize)(?:\/|$)/,
  /^\/api\/(?:pdfcert|dataplate\/extract)(?:\/|$)/,
  /^\/api\/inspections\/(?:punchlist|project-report|export-zip|[^/]+\/export-xlsx)(?:\/|$)/,
  /^\/api\/admin\/trainings\/[^/]+\/(?:generate|zip|stamp-qr)(?:\/|$)/,
  /^\/api\/vector-files(?:\/|$)/,
];

function timeoutForRequest(req) {
  const requestPath = req.path || req.url || '';
  if (UNLIMITED_TIMEOUT_PATHS.some((pattern) => pattern.test(requestPath))) return 0;
  if (LONG_TIMEOUT_PATHS.some((pattern) => pattern.test(requestPath))) return LONG_REQUEST_TIMEOUT_MS;
  return NORMAL_REQUEST_TIMEOUT_MS;
}

app.use((req, res, next) => {
  const timeoutMs = timeoutForRequest(req);
  req.setTimeout(timeoutMs);
  const deadlineTimer = timeoutMs > 0
    ? setTimeout(() => {
        if (res.headersSent) return res.destroy();
        return res.status(504).json({ ok: false, error: 'Request timed out', requestId: req.requestId || null });
      }, timeoutMs)
    : null;
  if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  const clearDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  };
  res.once('finish', clearDeadline);
  res.once('close', clearDeadline);
  res.setTimeout(timeoutMs, () => {
    if (res.headersSent) return res.destroy();
    return res.status(504).json({ ok: false, error: 'Request timed out', requestId: req.requestId || null });
  });
  next();
});

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
app.use(auditMiddleware);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/results', express.static(path.join(__dirname, 'results')));
function readinessSnapshot() {
  const mongoReady = mongoose.connection.readyState === 1;
  const settingsReady = runtimeState.settingsReady && systemSettingsStore._debug().ready;
  const ready = !runtimeState.shuttingDown && runtimeState.initialized && mongoReady && settingsReady;
  return {
    ok: ready,
    role: 'api',
    checks: {
      initialized: runtimeState.initialized,
      shuttingDown: runtimeState.shuttingDown,
      mongo: mongoReady,
      systemSettings: settingsReady,
      worker: backgroundJobsDisabled() ? 'external-or-disabled' : (runtimeState.workerStarted ? 'started' : 'not-started'),
    },
  };
}

app.get('/health/live', (_req, res) => {
  res.status(200).json({ ok: true, role: 'api' });
});

app.get(['/health', '/health/ready'], (_req, res) => {
  const snapshot = readinessSnapshot();
  if (!snapshot.ok) return res.status(503).json(snapshot);
  return res.status(200).json(snapshot);
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

  function sanitizeSsePathForLogs(p) {
    const s = String(p || '');
    // Redact common sensitive query params (EventSource often uses ?token=... because headers are not supported).
    return s
      .replace(/([?&]token=)[^&]+/gi, '$1[REDACTED]')
      .replace(/([?&]access_token=)[^&]+/gi, '$1[REDACTED]')
      .replace(/([?&]auth=)[^&]+/gi, '$1[REDACTED]');
  }

  if (acceptsSSE) {
    // Extra SSE headers for proxy compatibility and to avoid transforms/buffering
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Mark request for downstream handlers (controllers) if needed
    req.isSSE = true;
    sseResponses.add(res);
    res.once('close', () => sseResponses.delete(res));

	    if (res.socket && typeof res.socket.setTimeout === 'function') {
	      res.socket.setTimeout(0); // disable idle socket timeout for SSE
	    }
	    req.on('aborted', () => logger.warn('SSE client aborted the connection', { requestId: req.requestId, path: sanitizeSsePathForLogs(req.originalUrl) }));
	    // Normal behavior for EventSource / stream consumers; keep at debug to avoid log spam.
	    req.on('close',   () => logger.debug('SSE connection closed by client', { requestId: req.requestId, path: sanitizeSsePathForLogs(req.originalUrl) }));
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
app.use('/api', navigationRoutes);
app.use('/api', userRoutes);
app.use('/api', feedbackRoutes);
app.use('/api', ocrRoutes);
app.use('/api', openaiRoutes);
app.use('/api/vision', visionRoutes);
app.use('/api', exRegisterRoutes);
app.use('/api', certificateRoutes);
app.use('/api', certificateDraftRoutes);
app.use('/api/cert-requests', certificateRequestRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/units', zoneRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api', injectionRoutes);
app.use('/api', notificationsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api', upgradeRoutes);
app.use('/api', tenantRoutes);
app.use('/api', tenantAccessRoutes);
app.use('/api', auditRoutes);
app.use('/api', documentationRoutes);
app.use('/api', healthMetricsRoutes);
app.use('/api', statusSummaryRoutes);
app.use('/api', rootCauseRoutes);
app.use('/api', maintenanceSeverityRoutes);
app.use('/api', dashboardSettingsRoutes);
app.use('/api', dashboardAnalyticsRoutes);
app.use('/api', plannedInspectionRoutes);
app.use('/api', inviteRoutes);
app.use('/api', consentRoutes);
app.use('/api', inspectionRoutes);
app.use('/api', downloadRoutes);
app.use('/api', mobileSyncRoutes);
app.use('/api', systemSettingsRoutes);
app.use('/api', tenantSettingsRoutes);
app.use('/api', manufacturerRoutes);
app.use('/api', equipmentConflictRoutes);
app.use('/api', customFieldRoutes);
app.use('/api', schemaRoutes);
app.use('/api/public', publicRotRoutes);
app.use('/api', trainingRoutes);
app.use(errorAuditMiddleware);
app.use(apiErrorHandler);

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

let shutdownPromise = null;

function closeHttpServer() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    runtimeState.shuttingDown = true;
    runtimeState.initialized = false;
    const graceMs = Math.max(30_000, Number(process.env.SHUTDOWN_GRACE_MS || 10 * 60_000));
    logger.warn('Application shutdown started', { reason, graceMs });

    for (const res of sseResponses) {
      try { res.end(); } catch {}
    }
    sseResponses.clear();

    const drain = Promise.allSettled([
      closeHttpServer(),
      stopWorkerRuntime({ drainTimeoutMs: graceMs }),
    ]);
    let forced = false;
    await Promise.race([
      drain,
      new Promise((resolve) => setTimeout(() => {
        forced = true;
        for (const socket of openSockets) socket.destroy();
        resolve();
      }, graceMs)),
    ]);

    systemSettingsStore.stop();
    await mongoose.connection.close(false).catch((err) => {
      logger.error('MongoDB close failed during shutdown', { error: err?.message || String(err) });
    });
    logger.warn('Application shutdown completed', { reason, forced });
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
  void writeSystemAuditLog({ action: 'server.unhandledRejection', error: reason });
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  void writeSystemAuditLog({ action: 'server.uncaughtException', error: err });
  void shutdown('uncaughtException', 1);
});

async function main() {
  console.log('Starting application...');
  await connectDB();
  console.log('Database connected successfully');

  const seedResult = await seedInitialSuperAdminIfEmpty();
  if (seedResult?.reason === 'failed') {
    throw seedResult.error || new Error('Initial SuperAdmin seed failed');
  }
  const questionSeedResult = await seedRbQuestionsIfEmpty();
  if (questionSeedResult?.seeded) {
    console.log(`Seeded ${questionSeedResult.count} global RB questions`);
  }

  await systemSettingsStore.start();
  runtimeState.settingsReady = true;

  if (!backgroundJobsDisabled()) {
    const workerResult = startWorkerRuntime();
    runtimeState.workerStarted = Boolean(workerResult.started || workerResult.reason === 'already_started');
    if (!runtimeState.workerStarted) {
      throw new Error(`Worker runtime failed to start: ${workerResult.reason || 'unknown'}`);
    }
  }

  runtimeState.initialized = true;

  const host = process.env.HOST || '0.0.0.0';
  server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(port, host, () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });

  console.log(`Server listening on http://${host}:${port}`);
  // Body upload ceiling; route-specific response deadlines are enforced by middleware above.
  server.requestTimeout = LONG_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
}

main().catch((err) => {
  runtimeState.initialized = false;
  logger.error(`Application startup failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
