const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const healthMetricsController = require('../controllers/healthMetricsController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // ideiglenes mappa



router.post('/', authMiddleware(), requireAccess('site', 'create'), siteController.createSite);        // Új site létrehozása
router.get('/', authMiddleware(), requireAccess('site', 'read'), siteController.getAllSites);        // Összes site listázása
router.get('/:id/summary', authMiddleware(), requireAccess('site', 'read'), siteController.getSiteSummary); // Site összefoglaló
router.get('/:id/operational-summary', authMiddleware(), requireAccess('site', 'read'), siteController.getSiteOperationalSummary); // Operational status summary
router.get('/:id/overall-status-summary', authMiddleware(), requireAccess('site', 'read'), siteController.getSiteOverallStatusSummary); // Overall status summary
router.get('/:id/maintenance-severity-summary', authMiddleware(), requireTenantFeature('maintenance'), requireAccess('site', 'read'), siteController.getSiteMaintenanceSeveritySummary);
router.get('/:id/health-metrics', authMiddleware(), requireAccess('site', 'read'), healthMetricsController.getSiteHealthMetrics);
router.get('/:id', authMiddleware(), requireAccess('site', 'read'), siteController.getSiteById);
router.put('/:id', authMiddleware(), requireAccess('site', 'update'), siteController.updateSite);
router.delete('/:id', authMiddleware(), requireAccess('site', 'delete'), siteController.deleteSite);
router.post(
    '/:id/upload-file',
    authMiddleware(),
    requireAccess('site', 'update'),
    upload.array('files'),
    siteController.uploadFileToSite
  );
  router.delete(
    '/:siteId/files/:fileId',
    authMiddleware(),
    requireAccess('site', 'update'),
    siteController.deleteFileFromSite
  );
  router.get(
    '/:id/files',
    authMiddleware(),
    requireAccess('site', 'read'),
    siteController.getFilesOfSite
  );

module.exports = router;
