const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/customFieldController');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');

const router = express.Router();

router.get('/custom-fields/meta', authMiddleware(), requireTenantFeature('customFields'), controller.meta);
router.get('/custom-fields/sync', authMiddleware(), requireTenantFeature('customFields'), controller.syncConfig);
router.get('/custom-fields', authMiddleware(), requireTenantFeature('customFields'), controller.listCustomFields);
router.post('/custom-fields', authMiddleware(['Admin', 'SuperAdmin']), requireTenantFeature('customFields'), express.json(), controller.createCustomField);
router.put('/custom-fields/:id', authMiddleware(['Admin', 'SuperAdmin']), requireTenantFeature('customFields'), express.json(), controller.updateCustomField);
router.delete('/custom-fields/:id', authMiddleware(['Admin', 'SuperAdmin']), requireTenantFeature('customFields'), controller.deleteCustomField);

router.get('/field-layouts', authMiddleware(), requireTenantFeature('customFields'), controller.getFieldLayout);
router.put('/field-layouts', authMiddleware(['Admin', 'SuperAdmin']), requireTenantFeature('customFields'), express.json(), controller.saveFieldLayout);

module.exports = router;
