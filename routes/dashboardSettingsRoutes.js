const express = require('express');
const { authMiddleware } = require('../middlewares/authMiddleware');
const dashboardSettingsController = require('../controllers/dashboardSettingsController');

const router = express.Router();

// GET /api/dashboard-settings/sla-targets
router.get('/dashboard-settings/sla-targets', authMiddleware(), dashboardSettingsController.getSlaTargets);

// PUT /api/dashboard-settings/sla-targets (Admin / SuperAdmin only)
router.put(
  '/dashboard-settings/sla-targets',
  authMiddleware(['Admin', 'SuperAdmin']),
  dashboardSettingsController.updateSlaTargets
);

module.exports = router;

