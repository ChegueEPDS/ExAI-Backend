const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const healthMetricsController = require('../controllers/healthMetricsController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // ideiglenes mappa



router.post('/', authMiddleware(), requirePermission('site:write'), siteController.createSite);        // Új site létrehozása
router.get('/', authMiddleware(), siteController.getAllSites);        // Összes site listázása
router.get('/:id/summary', authMiddleware(), siteController.getSiteSummary); // Site összefoglaló
router.get('/:id/operational-summary', authMiddleware(), siteController.getSiteOperationalSummary); // Operational status summary
router.get('/:id/overall-status-summary', authMiddleware(), siteController.getSiteOverallStatusSummary); // Overall status summary (combined maintenance + compliance)
router.get('/:id/maintenance-severity-summary', authMiddleware(), siteController.getSiteMaintenanceSeveritySummary); // Maintenance severity summary
router.get('/:id/health-metrics', authMiddleware(), healthMetricsController.getSiteHealthMetrics); // Failed→Passed / Fault→Repaired metrics
router.get('/:id', authMiddleware(), siteController.getSiteById);     // Egyedi site lekérése
router.put('/:id', authMiddleware(), requirePermission('site:write'), siteController.updateSite);      // Site módosítása
router.delete('/:id', authMiddleware(), requirePermission('site:write'), siteController.deleteSite);   // Site törlése
router.post(
    '/:id/upload-file',
    authMiddleware(),
    requirePermission('site:write'),
    upload.array('files'),
    siteController.uploadFileToSite
  );
  router.delete(
    '/:siteId/files/:fileId',
    authMiddleware(),
    requirePermission('site:write'),
    siteController.deleteFileFromSite
  );
  router.get(
    '/:id/files',
    authMiddleware(),
    siteController.getFilesOfSite
  );

module.exports = router;
