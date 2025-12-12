const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer'); 
const upload = multer({ dest: 'uploads/' });



// Létrehozás
router.post('/exreg', authMiddleware(), upload.array('pictures'), exRegisterController.createEquipment);

router.post('/exreg/import', authMiddleware(), express.json(), exRegisterController.createEquipment);

router.post('/exreg/:id/upload-images', authMiddleware(), upload.array('pictures'), exRegisterController.uploadImagesToEquipment);

// Equipment documents (images + files) upload / list / delete
router.post(
  '/exreg/:id/upload-documents',
  authMiddleware(),
  upload.array('files'),
  exRegisterController.uploadDocumentsToEquipment
);

router.post(
  '/exreg/import-xlsx',
  authMiddleware(),
  upload.single('file'),
  exRegisterController.importEquipmentXLSX
);

// Dokumentumok / képek tömeges importja ZIP-ből
router.post(
  '/exreg/import-documents-zip',
  authMiddleware(),
  upload.single('file'),
  exRegisterController.importEquipmentDocumentsZip
);

// Ideiglenes feltöltési fájlok (félbehagyott ZIP-ek) manuális takarítása
router.post(
  '/exreg/import-documents-zip/cleanup-temp',
  authMiddleware(),
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
  exRegisterController.deleteDocumentFromEquipment
);

// Listázás
router.get('/exreg', authMiddleware(), exRegisterController.listEquipment);

// Lekérés ID alapján (GET /exreg/:id)
router.get('/exreg/:id', authMiddleware(), exRegisterController.getEquipmentById);

// Módosítás
router.put('/exreg/:id', authMiddleware(), upload.array('pictures'), exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', authMiddleware(), exRegisterController.deleteEquipment);

// Tömeges törlés
router.post('/exreg/bulk-delete', authMiddleware(), express.json(), exRegisterController.bulkDeleteEquipment);

// Gyártók lekérdezése
router.get('/manufacturers', authMiddleware(), exRegisterController.getManufacturers);


module.exports = router;
