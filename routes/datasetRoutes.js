const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const datasetController = require('../controllers/datasetController');

const router = express.Router();

router.post('/projects/:projectId/datasets', requireAuth, datasetController.createDataset);
router.get('/projects/:projectId/datasets', requireAuth, datasetController.listDatasets);

// List dataset files for a version (useful for UIs that want to show what is already attached to the project dataset).
router.get('/projects/:projectId/datasets/:version/files', requireAuth, datasetController.listDatasetFiles);
router.post('/projects/:projectId/datasets/:version/files', requireAuth, ...datasetController.uploadDatasetFiles);
// Streaming variant to avoid proxy/browser timeouts during long indexing (SSE).
router.post('/projects/:projectId/datasets/:version/files/stream', requireAuth, ...datasetController.uploadDatasetFilesStream);
router.patch('/projects/:projectId/dataset-files/:datasetFileId/approval', requireAuth, datasetController.setDatasetFileApproval);
router.delete('/projects/:projectId/dataset-files/:datasetFileId', requireAuth, datasetController.deleteDatasetFile);
router.post('/projects/:projectId/datasets/:version/approve', requireAuth, datasetController.approveDatasetVersion);

module.exports = router;
