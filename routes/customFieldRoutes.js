const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/customFieldController');

const router = express.Router();

router.get('/custom-fields/meta', authMiddleware(), controller.meta);
router.get('/custom-fields/sync', authMiddleware(), controller.syncConfig);
router.get('/custom-fields', authMiddleware(), controller.listCustomFields);
router.post('/custom-fields', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.createCustomField);
router.put('/custom-fields/:id', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.updateCustomField);
router.delete('/custom-fields/:id', authMiddleware(['Admin', 'SuperAdmin']), controller.deleteCustomField);

router.get('/field-layouts', authMiddleware(), controller.getFieldLayout);
router.put('/field-layouts', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.saveFieldLayout);

module.exports = router;
