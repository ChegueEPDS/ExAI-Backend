const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const { diskUpload } = require('../middlewares/uploadFactory');
const mobileSyncController = require('../controllers/mobileSyncController');

const router = express.Router();
const upload = diskUpload({ fileSizeMb: 25, files: 50, fields: 200, parts: 300 });

router.post('/mobile/sync', authMiddleware(), requireAccess('equipment', 'create'), upload.array('files', 50), mobileSyncController.mobileSync);
router.get('/mobile/sync/:jobId/status', authMiddleware(), mobileSyncController.getMobileSyncStatus);
router.get('/mobile/deletions', authMiddleware(), requireAccess('equipment', 'read'), mobileSyncController.getMobileDeletions);

module.exports = router;
