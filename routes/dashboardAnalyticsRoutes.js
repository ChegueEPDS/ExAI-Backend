const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const dashboardAnalyticsController = require('../controllers/dashboardAnalyticsController');

const router = express.Router();

// GET /api/dashboard-analytics?scope=global|site|zone&siteId&zoneId&from&to
router.get('/dashboard-analytics', authMiddleware(), dashboardAnalyticsController.getDashboardAnalytics);

module.exports = router;

