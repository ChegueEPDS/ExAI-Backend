const express = require('express');
const router = express.Router();
const zoneController = require('../controllers/zoneController');
const healthMetricsController = require('../controllers/healthMetricsController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// Új projekt létrehozása
router.post('/', authMiddleware(), zoneController.createZone);

// Összes projekt lekérdezése
router.get('/', authMiddleware(), zoneController.getZones);

// Egy konkrét projekt lekérdezése ID alapján
router.get('/:id', authMiddleware(), zoneController.getZoneById);

// Operational status summary (maintenance states)
router.get('/:id/operational-summary', authMiddleware(), zoneController.getZoneOperationalSummary);
router.get('/:id/maintenance-severity-summary', authMiddleware(), zoneController.getZoneMaintenanceSeveritySummary);
router.get('/:id/health-metrics', authMiddleware(), healthMetricsController.getZoneHealthMetrics);

// Projekt módosítása ID alapján
router.put('/:id', authMiddleware(), zoneController.updateZone);

// Projekt törlése ID alapján
router.delete('/:id', authMiddleware(), zoneController.deleteZone);

router.post(
    '/:id/upload-file',
    authMiddleware(),
    upload.array('files'),
    zoneController.uploadFileToZone
  );

// XLSX import zónákhoz (egy adott site alá)
router.post(
  '/import-xlsx',
  authMiddleware(),
  upload.single('file'),
  zoneController.importZonesFromXlsx
);
  
  router.get(
    '/:id/files',
    authMiddleware(),
    zoneController.getFilesOfZone
  );

  router.delete(
    '/:zoneId/files/:fileId',
    authMiddleware(),
    zoneController.deleteFileFromZone
  );

  // Összes eszközkép törlése egy zónán belül
  router.delete(
    '/:id/equipment-images',
    authMiddleware(),
    zoneController.deleteEquipmentImagesInZone
  );

module.exports = router;
