const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
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

const app = express();
app.set('trust proxy', 1); // Csak teszt környezetben
const port = process.env.PORT || 3000;

connectDB().then(() => console.log('Database connected successfully')).catch((err) => {
  console.error('Database connection failed:', err);
  process.exit(1); // Exit if DB connection fails
});

const allowedOrigins = [
  'https://lemon-moss-0ce31f803.5.azurestaticapps.net', // Az Azure Static Web Apps URL-je
  'https://jolly-field-070def303.5.azurestaticapps.net',
  'https://lively-mushroom-07ad34003.5.azurestaticapps.net',
  'https://kind-glacier-01525a703.5.azurestaticapps.net',
  'https://thankful-meadow-0ab025703.4.azurestaticapps.net',
  'https://delightful-rock-0f7815803.4.azurestaticapps.net',
  'https://happy-flower-09c1d5603.4.azurestaticapps.net',
  'https://demo.epds.eu',
  'https://stand98.demo.epds.eu',
  'https://exai.ind-ex.ae',
  'https://gray-grass-070bf1a03.4.azurestaticapps.net',
];

app.use(cors({
  origin: function (origin, callback) {
    // Ha az origin szerepel az engedélyezett listában, engedélyezd a hozzáférést
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
app.use(session({
  secret: 'yourSecretKey',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: true }
}));
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

// Periodikus tisztítás
setInterval(cleanupService.removeEmptyConversations, 3 * 60 * 60 * 1000); // 3 órás intervallum

console.log("Starting application...");
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
