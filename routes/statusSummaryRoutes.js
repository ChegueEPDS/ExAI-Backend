const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const statusSummaryController = require('../controllers/statusSummaryController');

// Tenant-wide: Overall + Maintenance + Ex Compliance status buckets
// GET /api/status-stacked-summary
router.get('/status-stacked-summary', authMiddleware(), statusSummaryController.getTenantStatusStackedSummary);

module.exports = router;

