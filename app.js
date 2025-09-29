require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const limiter = require('./middlewares/rateLimiter');
const cleanupService = require('./services/cleanupService');
const subscriptionSweeper = require('./services/subscriptionSweeper');
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
const xlsCompareRoutes = require('./routes/xlsCompareRoutes')
const graphRoutes = require('./routes/graphRoutes');
const injectionRoutes = require('./routes/injectionRoutes');
const dxfRoute = require('./routes/dxfRoutes');
const certificateDraftRoutes = require('./routes/certificateDraftRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');
const billingRoutes = require('./routes/billing');
const billingWebhook = require('./routes/billingWebhook');
const upgradeRoutes = require('./routes/upgrade');
const tenantRoutes = require('./routes/tenantRoutes');
const inviteRoutes = require('./routes/inviteRoutes');

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

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [];

// Reusable CORS options (applies to REST + SSE)
const corsOptions = {
  origin: function (origin, callback) {
    // allow same-origin or server-to-server (no origin), and allow-listed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'x-ms-graph-token',
    'x-user-id',        // frontend legacy header (allowed for backwards-compat)
    'x-tenant-id',      // optional explicit tenant header if ever sent
    'x-request-id',     // optional tracing
    'x-client-version'  // optional client versioning
  ],
  // make sure caches/proxies vary on Origin
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// Ensure CORS is applied to preflight requests across all routes
app.options('*', cors(corsOptions));

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

// SSE hardening for the stream endpoint
app.use((req, res, next) => {
  if (req.path === '/api/upload-and-summarize/stream') {
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
    res.setHeader('Vary', 'Origin');

    // avoid idle timeouts on this request only
    if (res.socket && typeof res.socket.setTimeout === 'function') {
      res.socket.setTimeout(0);
    }
    if (req.socket && typeof req.socket.setKeepAlive === 'function') {
      req.socket.setKeepAlive(true);
    }

    // if your handler uses res.write() immediately, you can flush headers:
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    req.isSSE = true; // jelölő, ha a controllerben használni szeretnéd
  }
  next();
});

// (opcionális) explicit OPTIONS a streamre – a globális CORS amúgy is kezeli
app.options('/api/upload-and-summarize/stream', cors({ origin: true, credentials: true }));

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
app.use('/api/questions', questionsRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/xls', xlsCompareRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api', injectionRoutes);
app.use('/api/dxf', dxfRoute);
app.use('/api', certificateDraftRoutes);
app.use('/api', notificationsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api', upgradeRoutes);
app.use('/api', tenantRoutes);
app.use('/api', inviteRoutes);

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

// Periodikus tisztítás
setInterval(cleanupService.removeEmptyConversations, 3 * 60 * 60 * 1000); // 3 órás intervallum
setInterval(cleanupService.cleanupDxfResults, 3 * 60 * 60 * 1000);
setInterval(subscriptionSweeper.sweepExpiredSubscriptions, 60 * 60 * 1000);

console.log("Starting application...");
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  // Consider graceful shutdown in production
});

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// --- Keep long SSE connections alive and avoid premature timeouts ---
// Never time out HTTP requests (Node's default can cut long streams)
server.requestTimeout = 0;
// Keep the TCP connection alive long enough for proxies (ALB/Nginx) to stay happy
server.keepAliveTimeout = 75_000;
// Must be greater than keepAliveTimeout (Node requirement)
server.headersTimeout = 80_000;