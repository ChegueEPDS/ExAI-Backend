const express = require('express');
const { authMiddleware } = require('../middlewares/authMiddleware');
const controller = require('../controllers/systemSettingsController');

const router = express.Router();

// Deliberately public: the frontend must be able to show maintenance before login.
router.get('/maintenance-status', controller.getMaintenanceStatusPublic);

// SuperAdmin-only global system settings (applies to all tenants)
router.get('/admin/system-settings', authMiddleware(['SuperAdmin']), controller.getSystemSettings);
router.put('/admin/system-settings', authMiddleware(['SuperAdmin']), controller.updateSystemSettings);
router.post('/admin/system-settings/reset', authMiddleware(['SuperAdmin']), controller.resetSystemSettingsToDefault);
router.get('/admin/openai-models', authMiddleware(['SuperAdmin']), controller.listOpenAiModels);

module.exports = router;
