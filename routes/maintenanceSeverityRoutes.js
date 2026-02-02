const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const maintenanceSeverityController = require('../controllers/maintenanceSeverityController');

const router = express.Router();

// GET /api/maintenance-severity-summary
router.get('/maintenance-severity-summary', authMiddleware(), maintenanceSeverityController.getTenantMaintenanceSeveritySummary);

module.exports = router;

