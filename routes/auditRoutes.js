const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const auditController = require('../controllers/auditController');

const router = express.Router();

router.get('/admin/audit-logs', authMiddleware(['SuperAdmin']), auditController.listAuditLogs);

module.exports = router;
