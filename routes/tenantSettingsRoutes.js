const express = require('express');
const { authMiddleware } = require('../middlewares/authMiddleware');
const controller = require('../controllers/tenantSettingsController');

const router = express.Router();

// Admin + SuperAdmin: tenant-scoped settings
router.get('/admin/tenant-settings', authMiddleware(['Admin', 'SuperAdmin']), controller.getTenantSettings);
router.put('/admin/tenant-settings', authMiddleware(['Admin', 'SuperAdmin']), controller.updateTenantSettings);
router.post('/admin/tenant-settings/reset', authMiddleware(['Admin', 'SuperAdmin']), controller.resetTenantSettingsToDefault);

module.exports = router;

