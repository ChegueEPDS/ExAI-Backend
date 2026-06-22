const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');
const maintenanceController = require('../controllers/maintenanceController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');
const multer = require('multer'); 
const upload = multer({ dest: 'uploads/' });



// Létrehozás
router.post('/exreg', authMiddleware(), requireAccess('equipment', 'create'), upload.array('pictures'), exRegisterController.createEquipment);

router.post('/exreg/import', authMiddleware(), requireAccess('equipment', 'create'), express.json(), exRegisterController.createEquipment);

router.post('/exreg/:id/upload-images', authMiddleware(), requireAccess('equipment', 'update'), upload.array('pictures'), exRegisterController.uploadImagesToEquipment);

// Equipment documents (images + files) upload / list / delete
router.post(
  '/exreg/:id/upload-documents',
  authMiddleware(),
  requireAccess('equipment', 'update'),
  upload.array('files'),
  exRegisterController.uploadDocumentsToEquipment
);

router.post(
  '/exreg/import-xlsx',
  authMiddleware(),
  requireAccess('equipment', 'create'),
  upload.single('file'),
  exRegisterController.importEquipmentXLSX
);

router.get(
  '/exreg/import-template',
  authMiddleware(),
  exRegisterController.downloadEquipmentImportTemplate
);

// Dokumentumok / képek tömeges importja ZIP-ből
router.post(
  '/exreg/import-documents-zip',
  authMiddleware(),
  requireAccess('equipment', 'create'),
  upload.single('file'),
  exRegisterController.importEquipmentDocumentsZip
);

// Ideiglenes feltöltési fájlok (félbehagyott ZIP-ek) manuális takarítása
router.post(
  '/exreg/import-documents-zip/cleanup-temp',
  authMiddleware(),
  requireAccess('equipment', 'update'),
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
  requireAccess('equipment', 'read'),
  exRegisterController.exportEquipmentXLSX
);

router.get(
  '/exreg/export-ui-xlsx',
  authMiddleware(),
  requireAccess('equipment', 'read'),
  exRegisterController.exportEquipmentUiXLSX
);

router.get(
  '/exreg/certificate-summary',
  authMiddleware(),
  requireAccess('equipment', 'read'),
  exRegisterController.exportZoneCertificateSummary
);

// ÚJ compact verzió:
router.get(
  '/exreg/certificate-summary-compact',
  authMiddleware(),
  requireAccess('equipment', 'read'),
  exRegisterController.exportZoneCertificateSummaryCompact
);


router.get(
  '/exreg/:id/documents',
  authMiddleware(),
  requireAccess('equipment', 'read'),
  exRegisterController.getDocumentsOfEquipment
);

router.delete(
  '/exreg/:id/documents/:docId',
  authMiddleware(),
  requireAccess('equipment', 'update'),
  exRegisterController.deleteDocumentFromEquipment
);

// Listázás
router.get('/exreg', authMiddleware(), requireAccess('equipment', 'read'), exRegisterController.listEquipment);

// Lekérés ID alapján (GET /exreg/:id)
router.get('/exreg/:id', authMiddleware(), requireAccess('equipment', 'read'), exRegisterController.getEquipmentById);

// Equipment data history (SCD2-like versions)
router.get('/exreg/:id/versions', authMiddleware(), requireAccess('equipment', 'read'), exRegisterController.listEquipmentDataVersions);
router.get('/exreg/:id/versions/:versionId', authMiddleware(), requireAccess('equipment', 'read'), exRegisterController.getEquipmentDataVersion);

// Unified timeline history: inspections + equipment versions + maintenance actions
router.get('/exreg/:id/history', authMiddleware(), requireAccess('equipment', 'read'), maintenanceController.getEquipmentHistory);

// Maintenance actions
router.post('/exreg/:id/maintenance/faults', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('maintenance', 'create'), maintenanceController.reportFault);
router.post('/exreg/:id/maintenance/repairs/start', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('maintenance', 'update'), maintenanceController.startRepair);
router.post('/exreg/:id/maintenance/repairs/:repairId/complete', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('maintenance', 'update'), maintenanceController.completeRepair);
router.post('/exreg/:id/maintenance/schemas/:schemaId/activities', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('maintenance', 'create'), express.json(), maintenanceController.createCustomActivity);

// Módosítás
router.put('/exreg/:id', authMiddleware(), requireAccess('equipment', 'update'), upload.array('pictures'), exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', authMiddleware(), requireAccess('equipment', 'delete'), exRegisterController.deleteEquipment);

// Tömeges törlés
router.post('/exreg/bulk-delete', authMiddleware(), requireAccess('equipment', 'delete'), express.json(), exRegisterController.bulkDeleteEquipment);

module.exports = router;
