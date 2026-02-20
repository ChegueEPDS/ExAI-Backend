const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const equipmentConflictController = require('../controllers/equipmentConflictController');

router.get('/equipment-conflicts', authMiddleware(), equipmentConflictController.listConflicts);
router.get('/equipment-conflicts/:id', authMiddleware(), equipmentConflictController.getConflict);
router.post('/equipment-conflicts/:id/resolve', authMiddleware(), express.json(), equipmentConflictController.resolveConflict);

module.exports = router;
