const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const dashboardSnapshotController = require('../controllers/dashboardSnapshotController');

const router = express.Router();
router.get('/dashboard-snapshot', authMiddleware(), dashboardSnapshotController.getDashboardSnapshot);

module.exports = router;
