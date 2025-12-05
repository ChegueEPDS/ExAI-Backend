const express = require('express');
const router = express.Router();
const inspectionController = require('../controllers/inspectionController');
const exportInspectioReport = require('../controllers/exportInsepctionReport');
const authMiddleware = require('../middlewares/authMiddleware');

// 
// Új inspection létrehozása
// POST /api/inspections
router.post('/inspections', authMiddleware(), express.json(), inspectionController.createInspection);
router.post('/inspections/upload-attachment', authMiddleware(), inspectionController.uploadInspectionAttachment);
router.delete('/inspections/attachment', authMiddleware(), express.json(), inspectionController.deleteInspectionAttachment);

// Inspectionök listázása szűrőkkel
// GET /api/inspections
router.get('/inspections', authMiddleware(), inspectionController.listInspections);

router.get('/inspections/punchlist', authMiddleware(), exportInspectioReport.exportPunchlistXLSX);
router.get('/inspections/export-zip', authMiddleware(), exportInspectioReport.exportLatestInspectionReportsZip);
router.get('/inspections/:id/export-xlsx', authMiddleware(), exportInspectioReport.exportInspectionXLSX);

// Konkrét inspection lekérése ID alapján
// GET /api/inspections/:id
router.get('/inspections/:id', authMiddleware(), inspectionController.getInspectionById);

// Inspection törlése
// DELETE /api/inspections/:id
router.delete('/inspections/:id', authMiddleware(), inspectionController.deleteInspection);

module.exports = router;
