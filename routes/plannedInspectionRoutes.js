const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const plannedInspectionController = require('../controllers/plannedInspectionController');

const router = express.Router();

// GET /api/planned-inspections?scope=global|site|zone&siteId&zoneId&limit=5
router.get('/planned-inspections', authMiddleware(), plannedInspectionController.getPlannedInspections);

module.exports = router;

