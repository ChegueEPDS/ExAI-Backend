require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const limiter = require('./middlewares/rateLimiter');
const cleanupService = require('./services/cleanupService');
const path = require('path');

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
const dxfRoute = require('./routes/dxf');
const certificateDraftRoutes = require('./routes/certificateDraftRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');

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
  allowedHeaders: ['Authorization', 'Content-Type', 'x-ms-graph-token'],
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(limiter);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/results', express.static(path.join(__dirname, 'results')));
app.get('/', (req, res) => {
  res.send('Welcome to the application!');
});
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

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

// Periodikus tisztítás
setInterval(cleanupService.removeEmptyConversations, 3 * 60 * 60 * 1000); // 3 órás intervallum
setInterval(cleanupService.cleanupDxfResults, 3 * 60 * 60 * 1000);

console.log("Starting application...");
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  // Consider graceful shutdown in production
});
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log("Azure Tenant ID:", process.env.AZURE_TENANT_ID);
  console.log("Azure Redirect URI:", process.env.AZURE_REDIRECT_URI);
});