const express = require('express');
const router = express.Router();
const inspectionController = require('../controllers/inspectionController');
const exportInspectioReport = require('../controllers/exportInsepctionReport');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');

// 
// Új inspection létrehozása
// POST /api/inspections
router.post('/inspections', authMiddleware(), requirePermission('inspection:manage'), express.json(), inspectionController.createInspection);
router.put('/inspections/:id', authMiddleware(), requirePermission('inspection:manage'), express.json(), inspectionController.updateInspection);
router.post('/inspections/:id/regenerate', authMiddleware(), requirePermission('inspection:manage'), express.json(), inspectionController.regenerateInspection);
router.post('/inspections/upload-attachment', authMiddleware(), requirePermission('inspection:manage'), inspectionController.uploadInspectionAttachment);
router.delete('/inspections/attachment', authMiddleware(), requirePermission('inspection:manage'), express.json(), inspectionController.deleteInspectionAttachment);

// Inspectionök listázása szűrőkkel
// GET /api/inspections
router.get('/inspections', authMiddleware(), inspectionController.listInspections);

router.get('/inspections/punchlist', authMiddleware(), exportInspectioReport.exportPunchlistXLSX);
router.get('/inspections/project-report', authMiddleware(), exportInspectioReport.exportProjectFullReport);
router.get('/inspections/export-zip', authMiddleware(), exportInspectioReport.exportLatestInspectionReportsZip);
router.get('/inspections/export-jobs', authMiddleware(), exportInspectioReport.listInspectionExportJobs);
router.get('/inspections/export-jobs/:jobId', authMiddleware(), exportInspectioReport.getInspectionExportJob);
router.delete('/inspections/export-jobs/:jobId', authMiddleware(), requirePermission('inspection:manage'), exportInspectioReport.deleteInspectionExportJob);
router.get('/inspections/:id/export-xlsx', authMiddleware(), exportInspectioReport.exportInspectionXLSX);

// Konkrét inspection lekérése ID alapján
// GET /api/inspections/:id
router.get('/inspections/:id', authMiddleware(), inspectionController.getInspectionById);

// Inspection törlése
// DELETE /api/inspections/:id
router.delete('/inspections/:id', authMiddleware(), requirePermission('inspection:manage'), inspectionController.deleteInspection);

module.exports = router;
