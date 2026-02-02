const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const datasetController = require('../controllers/datasetController');

const router = express.Router();

router.post('/projects/:projectId/datasets', requireAuth, datasetController.createDataset);
router.get('/projects/:projectId/datasets', requireAuth, datasetController.listDatasets);

router.post('/projects/:projectId/datasets/:version/files', requireAuth, ...datasetController.uploadDatasetFiles);
router.patch('/projects/:projectId/dataset-files/:datasetFileId/approval', requireAuth, datasetController.setDatasetFileApproval);
router.delete('/projects/:projectId/dataset-files/:datasetFileId', requireAuth, datasetController.deleteDatasetFile);
router.post('/projects/:projectId/datasets/:version/approve', requireAuth, datasetController.approveDatasetVersion);

module.exports = router;

