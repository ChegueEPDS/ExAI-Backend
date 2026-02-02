const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const healthMetricsController = require('../controllers/healthMetricsController');

// Tenant-wide health metrics (compliance + maintenance)
// GET /api/health-metrics
router.get('/health-metrics', authMiddleware(), healthMetricsController.getTenantHealthMetrics);

module.exports = router;

