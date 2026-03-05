// routes/trainingRoutes.js
const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const requireIndexTenantOrSuperAdmin = require('../middlewares/indexTenantOrSuperAdmin');
const controller = require('../controllers/trainingController');

const router = express.Router();

// All endpoints require login, then allow if Index tenant OR SuperAdmin (any tenant)
router.use(authMiddleware());
router.use(requireIndexTenantOrSuperAdmin);

// Settings
router.get('/admin/trainings/settings', controller.getTrainingSettings);
router.post('/admin/trainings/settings/template', ...controller.uploadRotTemplate);

// Units
router.get('/admin/trainings/units', controller.listUnits);
router.post('/admin/trainings/units', express.json(), controller.createUnit);
router.patch('/admin/trainings/units/:id', express.json(), controller.updateUnit);
router.delete('/admin/trainings/units/:id', controller.deleteUnit);

// Trainings
router.get('/admin/trainings', controller.listTrainings);
router.get('/admin/trainings/next-record-no', controller.getNextRecordOfTrainingNo);
router.post('/admin/trainings', ...controller.createTraining);
router.get('/admin/trainings/:id', controller.getTraining);
router.get('/admin/trainings/:id/xlsx', controller.getXlsxDownloadUrl);
router.post('/admin/trainings/:id/generate', controller.generateRotDocs);
router.post('/admin/trainings/:id/zip', controller.generateRotZip);
router.get('/admin/trainings/:id/candidates/:candidateId/download', controller.getCandidateDownloadUrl);

module.exports = router;
