const express = require('express');
const multer = require('multer');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const mobileSyncController = require('../controllers/mobileSyncController');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/mobile/sync', authMiddleware(), requireAccess('equipment', 'create'), upload.array('files'), mobileSyncController.mobileSync);
router.get('/mobile/sync/:jobId/status', authMiddleware(), mobileSyncController.getMobileSyncStatus);
router.get('/mobile/deletions', authMiddleware(), requireAccess('equipment', 'read'), mobileSyncController.getMobileDeletions);

module.exports = router;
