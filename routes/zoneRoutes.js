const express = require('express');
const router = express.Router();
const zoneController = require('../controllers/zoneController');
const documentationController = require('../controllers/documentationController');
const healthMetricsController = require('../controllers/healthMetricsController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');
const { diskUpload } = require('../middlewares/uploadFactory');
const fileUpload = diskUpload({ fileSizeMb: 50, files: 20, fields: 50 });
const xlsxUpload = diskUpload({ fileSizeMb: 25, files: 1, fields: 30 });

// Új projekt létrehozása
router.post('/', authMiddleware(), requireAccess('zone', 'create'), zoneController.createZone);

// Összes projekt lekérdezése
router.get('/', authMiddleware(), requireAccess('zone', 'read'), zoneController.getZones);

// Egy konkrét projekt lekérdezése ID alapján
router.get('/:id', authMiddleware(), requireAccess('zone', 'read'), zoneController.getZoneById);

// Operational status summary (maintenance states)
router.get('/:id/operational-summary', authMiddleware(), requireAccess('zone', 'read'), zoneController.getZoneOperationalSummary);
router.get('/:id/maintenance-severity-summary', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('zone', 'read'), zoneController.getZoneMaintenanceSeveritySummary);
router.get('/:id/health-metrics', authMiddleware(), requireAccess('zone', 'read'), healthMetricsController.getZoneHealthMetrics);

// Projekt módosítása ID alapján
router.put('/:id', authMiddleware(), requireAccess('zone', 'update'), zoneController.updateZone);

// Projekt áthelyezése (parent váltás)
router.patch('/:id/move', authMiddleware(), requireAccess('zone', 'update'), zoneController.moveZone);

// Projekt törlése ID alapján
router.delete('/:id', authMiddleware(), requireAccess('zone', 'delete'), zoneController.deleteZone);

router.post(
    '/:id/upload-file',
    authMiddleware(),
    requireAccess('zone', 'update'),
    fileUpload.array('files', 20),
    zoneController.uploadFileToZone
  );

// XLSX import zónákhoz (egy adott site alá)
router.post(
  '/import-xlsx',
  authMiddleware(),
  requireAccess('zone', 'create'),
  xlsxUpload.single('file'),
  zoneController.importZonesFromXlsx
);
  
  router.get(
    '/:id/files',
    authMiddleware(),
    requireAccess('zone', 'read'),
    zoneController.getFilesOfZone
  );

  router.delete(
    '/:zoneId/files/:fileId',
    authMiddleware(),
    requireAccess('zone', 'update'),
    zoneController.deleteFileFromZone
  );
  router.post(
    '/:zoneId/documentations/:documentationId',
    authMiddleware(),
    requireTenantFeature('documentation'),
    requireAccess('documentation', 'update'),
    documentationController.attachToTarget
  );
  router.delete(
    '/:zoneId/documentations/:documentationId',
    authMiddleware(),
    requireTenantFeature('documentation'),
    requireAccess('documentation', 'update'),
    documentationController.detachFromTarget
  );

  // Összes eszközkép törlése egy zónán belül
  router.delete(
    '/:id/equipment-images',
    authMiddleware(),
    requireAccess('zone', 'delete'),
    zoneController.deleteEquipmentImagesInZone
  );

module.exports = router;
