const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/criteriaSystemController');

router.get('/criteria-systems', authMiddleware(), controller.list);
router.post('/criteria-systems', authMiddleware(['SuperAdmin']), express.json(), controller.create);
router.put('/criteria-systems/:id', authMiddleware(['SuperAdmin']), express.json(), controller.update);

router.get('/exreg/:equipmentId/criteria-systems', authMiddleware(), controller.getEquipmentSystems);
router.put('/exreg/:equipmentId/criteria-systems/:criteriaSystemId/assignment', authMiddleware(['SuperAdmin']), express.json(), controller.saveAssignment);
router.post('/exreg/:equipmentId/criteria-systems/:criteriaSystemId/completions', authMiddleware(), express.json(), controller.recordCompletion);
router.get('/exreg/:equipmentId/criteria-systems/compliance', authMiddleware(), controller.listComplianceForEquipment);

module.exports = router;
