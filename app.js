const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const limiter = require('./middlewares/rateLimiter');
const cleanupService = require('./services/cleanupService');
require('dotenv').config();
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
const inspectionRoutes = require('./routes/inspectionRoutes');
const zoneRoutes = require('./routes/zoneRoutes');
const siteRoutes = require('./routes/siteRoutes');
const xlsCompareRoutes = require('./routes/xlsCompareRoutes')
const app = express();
app.set('trust proxy', 1); // Csak teszt környezetben
const port = process.env.PORT || 3000;

connectDB().then(() => console.log('Database connected successfully')).catch((err) => {
  console.error('Database connection failed:', err);
  process.exit(1); // Exit if DB connection fails
});

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [];


  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: 'GET,POST,PUT,DELETE',
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type']
  }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(limiter);
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
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
app.use('/api/inspection', inspectionRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/xls', xlsCompareRoutes);

// Periodikus tisztítás
setInterval(cleanupService.removeEmptyConversations, 3 * 60 * 60 * 1000); // 3 órás intervallum

console.log("Starting application...");
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log("Azure Tenant ID:", process.env.AZURE_TENANT_ID);
console.log("Azure Redirect URI:", process.env.AZURE_REDIRECT_URI);
});