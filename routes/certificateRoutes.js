const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');
const authMiddleware = require('../middlewares/authMiddleware');
const { enforceDailyDownloadLimit, incrementDailyDownload } = require('../middlewares/quotaLimiter');

// Tanúsítvány feltöltés
router.post('/certificates/upload', authMiddleware(), certificateController.uploadCertificate);

// ATEX preview (server-side OCR + AI; no save, no blob upload)
router.post('/certificates/preview-atex', authMiddleware(), certificateController.previewAtex);

// Listázás
router.get('/certificates/samples', certificateController.getCertificatesSamples);
router.get('/certificates', authMiddleware(), certificateController.getCertificates);
router.get('/certificates/public', authMiddleware(), certificateController.getPublicCertificates);
router.get('/certificates/public/paged', authMiddleware(), certificateController.getPublicCertificatesPaged);
router.get('/certificates/paged', authMiddleware(), certificateController.getMyCertificatesPaged);
router.get('/certificates/public/contribution', authMiddleware(), certificateController.countMyPublicCertificates);

// Adopt / Unadopt
router.post('/certificates/:id/adopt', authMiddleware(), certificateController.adoptPublic);
router.delete('/certificates/:id/adopt', authMiddleware(), certificateController.unadoptPublic);
router.post('/certificates/resolve-bulk', authMiddleware(), certificateController.resolveCertificatesBulk);

// SAS link generálás tanúsítvány letöltéséhez
router.post(
  '/certificates/sas',
  authMiddleware(),
  enforceDailyDownloadLimit,
  incrementDailyDownload,
  certificateController.getCertificateSas
);
router.put('/certificates/update-to-public', authMiddleware(), certificateController.updateToPublic);


// Törlés
router.delete('/certificates/:id', authMiddleware(), certificateController.deleteCertificate);

// Módosítás
router.put('/certificates/:id', authMiddleware(), certificateController.updateCertificate);

// Összes riport listázása (opcionális status filter: ?status=new|resolved)
router.get('/certificates/reports', authMiddleware(), certificateController.listAllReports);

// Lekérés certNo alapján
router.get('/certificates/:certNo', authMiddleware(), certificateController.getCertificateByCertNo);

// === Certificate Report Routes ===

// #1 Create new report
router.post('/certificates/:id/reports', authMiddleware(), certificateController.addReport);

// #2 List reports (optional status filter)
router.get('/certificates/:id/reports', authMiddleware(), certificateController.listReports);

// #3 Update report status
router.patch('/certificates/:id/reports/:reportId', authMiddleware(), certificateController.updateReportStatus);

module.exports = router;
