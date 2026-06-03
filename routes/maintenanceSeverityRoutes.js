const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const maintenanceSeverityController = require('../controllers/maintenanceSeverityController');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');

const router = express.Router();

// GET /api/maintenance-severity-summary
router.get(
  '/maintenance-severity-summary',
  authMiddleware(),
  requireTenantFeature('maintenance'),
  maintenanceSeverityController.getTenantMaintenanceSeveritySummary
);

module.exports = router;
