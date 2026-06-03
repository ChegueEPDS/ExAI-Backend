const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const rootCauseController = require('../controllers/rootCauseController');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');

const router = express.Router();

// GET /api/root-causes/maintenance
router.get('/root-causes/maintenance', authMiddleware(), requireTenantFeature('maintenance'), rootCauseController.getMaintenanceRootCauses);

// GET /api/root-causes/compliance
router.get('/root-causes/compliance', authMiddleware(), rootCauseController.getComplianceRootCauses);

module.exports = router;
