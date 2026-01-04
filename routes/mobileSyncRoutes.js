const express = require('express');
const multer = require('multer');
const authMiddleware = require('../middlewares/authMiddleware');
const mobileSyncController = require('../controllers/mobileSyncController');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/mobile/sync', authMiddleware(), upload.array('files'), mobileSyncController.mobileSync);
router.get('/mobile/sync/:jobId/status', authMiddleware(), mobileSyncController.getMobileSyncStatus);

module.exports = router;

