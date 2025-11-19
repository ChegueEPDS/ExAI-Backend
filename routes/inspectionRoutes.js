const express = require('express');
const router = express.Router();
const inspectionController = require('../controllers/inspectionController');
const exportInspectioReport = require('../controllers/exportInsepctionReport');
const authMiddleware = require('../middlewares/authMiddleware');

// 
// Új inspection létrehozása
// POST /api/inspections
router.post('/inspections', authMiddleware(), express.json(), inspectionController.createInspection);

// Inspectionök listázása szűrőkkel
// GET /api/inspections
router.get('/inspections', authMiddleware(), inspectionController.listInspections);

// Konkrét inspection lekérése ID alapján
// GET /api/inspections/:id
router.get('/inspections/:id', authMiddleware(), inspectionController.getInspectionById);

router.get("/inspections/:id/export-xlsx", exportInspectioReport.exportInspectionXLSX);

module.exports = router;
