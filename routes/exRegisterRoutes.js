const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');
const maintenanceController = require('../controllers/maintenanceController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');
const multer = require('multer'); 
const upload = multer({ dest: 'uploads/' });



// Létrehozás
router.post('/exreg', authMiddleware(), requirePermission('asset:write'), upload.array('pictures'), exRegisterController.createEquipment);

router.post('/exreg/import', authMiddleware(), requirePermission('asset:write'), express.json(), exRegisterController.createEquipment);

router.post('/exreg/:id/upload-images', authMiddleware(), requirePermission('asset:write'), upload.array('pictures'), exRegisterController.uploadImagesToEquipment);

// Equipment documents (images + files) upload / list / delete
router.post(
  '/exreg/:id/upload-documents',
  authMiddleware(),
  requirePermission('asset:write'),
  upload.array('files'),
  exRegisterController.uploadDocumentsToEquipment
);

router.post(
  '/exreg/import-xlsx',
  authMiddleware(),
  requirePermission('asset:write'),
  upload.single('file'),
  exRegisterController.importEquipmentXLSX
);

// Dokumentumok / képek tömeges importja ZIP-ből
router.post(
  '/exreg/import-documents-zip',
  authMiddleware(),
  requirePermission('asset:write'),
  upload.single('file'),
  exRegisterController.importEquipmentDocumentsZip
);

// Ideiglenes feltöltési fájlok (félbehagyott ZIP-ek) manuális takarítása
router.post(
  '/exreg/import-documents-zip/cleanup-temp',
  authMiddleware(),
  requirePermission('asset:write'),
  exRegisterController.cleanupTempUploadsNow
);

// XLSX sablon a ZIP dokumentum-importhoz
router.get(
  '/exreg/documents-template',
  authMiddleware(),
  exRegisterController.downloadDocumentsTemplate
);

// Export XLSX a kiválasztott / zónához / projekthez tartozó eszközökhöz
router.get(
  '/exreg/export-xlsx',
  authMiddleware(),
  exRegisterController.exportEquipmentXLSX
);

router.get(
  '/exreg/export-ui-xlsx',
  authMiddleware(),
  exRegisterController.exportEquipmentUiXLSX
);

router.get(
  '/exreg/certificate-summary',
  authMiddleware(),
  exRegisterController.exportZoneCertificateSummary
);

// ÚJ compact verzió:
router.get(
  '/exreg/certificate-summary-compact',
  authMiddleware(),
  exRegisterController.exportZoneCertificateSummaryCompact
);


router.get(
  '/exreg/:id/documents',
  authMiddleware(),
  exRegisterController.getDocumentsOfEquipment
);

router.delete(
  '/exreg/:id/documents/:docId',
  authMiddleware(),
  requirePermission('asset:write'),
  exRegisterController.deleteDocumentFromEquipment
);

// Listázás
router.get('/exreg', authMiddleware(), exRegisterController.listEquipment);

// Lekérés ID alapján (GET /exreg/:id)
router.get('/exreg/:id', authMiddleware(), exRegisterController.getEquipmentById);

// Equipment data history (SCD2-like versions)
router.get('/exreg/:id/versions', authMiddleware(), exRegisterController.listEquipmentDataVersions);
router.get('/exreg/:id/versions/:versionId', authMiddleware(), exRegisterController.getEquipmentDataVersion);

// Unified timeline history: inspections + equipment versions + maintenance actions
router.get('/exreg/:id/history', authMiddleware(), maintenanceController.getEquipmentHistory);

// Maintenance actions
router.post('/exreg/:id/maintenance/faults', authMiddleware(), requirePermission(['maintenance:manage', 'maintenance:fault:report']), maintenanceController.reportFault);
router.post('/exreg/:id/maintenance/repairs/start', authMiddleware(), requirePermission('maintenance:manage'), maintenanceController.startRepair);
router.post('/exreg/:id/maintenance/repairs/:repairId/complete', authMiddleware(), requirePermission('maintenance:manage'), maintenanceController.completeRepair);

// Módosítás
router.put('/exreg/:id', authMiddleware(), requirePermission('asset:write'), upload.array('pictures'), exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', authMiddleware(), requirePermission('asset:write'), exRegisterController.deleteEquipment);

// Tömeges törlés
router.post('/exreg/bulk-delete', authMiddleware(), requirePermission('asset:write'), express.json(), exRegisterController.bulkDeleteEquipment);

module.exports = router;
