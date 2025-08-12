const express = require('express');
const router = express.Router();
const certificateDraftController = require('../controllers/certificateDraftController');
const notificationsController = require('../controllers/notificationsController');
const authMiddleware = require('../middlewares/authMiddleware')

router.post('/certificates/bulk-upload', authMiddleware(), certificateDraftController.bulkUpload);
router.post('/certificates/drafts/process/:uploadId', authMiddleware(), certificateDraftController.processDrafts);
router.get('/certificates/drafts/:uploadId', authMiddleware(), certificateDraftController.getDraftsByUploadId);
router.patch('/certificates/drafts/by-id/:id', authMiddleware(), certificateDraftController.updateDraftExtractedById);
router.post('/certificates/drafts/finalize/by-id/:id', authMiddleware(), certificateDraftController.finalizeSingleDraftById);
router.post('/certificates/drafts/finalize/:uploadId', authMiddleware(), certificateDraftController.finalizeDrafts);
router.get('/certificates/uploads/pending', authMiddleware(), certificateDraftController.getPendingUploads);
router.delete('/certificates/uploads/:uploadId', authMiddleware(), certificateDraftController.deletePendingUpload);

module.exports = router;