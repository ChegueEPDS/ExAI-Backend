const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const rootCauseController = require('../controllers/rootCauseController');

const router = express.Router();

// GET /api/root-causes/maintenance
router.get('/root-causes/maintenance', authMiddleware(), rootCauseController.getMaintenanceRootCauses);

// GET /api/root-causes/compliance
router.get('/root-causes/compliance', authMiddleware(), rootCauseController.getComplianceRootCauses);

module.exports = router;

