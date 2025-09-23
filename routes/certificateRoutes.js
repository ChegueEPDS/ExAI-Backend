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
router.get('/certificates/public/contribution', authMiddleware(), certificateController.countMyPublicCertificates);

// Adopt / Unadopt
router.post('/certificates/:id/adopt', authMiddleware(), certificateController.adoptPublic);
router.delete('/certificates/:id/adopt', authMiddleware(), certificateController.unadoptPublic);

// SAS link generálás tanúsítvány letöltéséhez
router.post(
  '/certificates/sas',
  authMiddleware(),
  enforceDailyDownloadLimit,
  incrementDailyDownload,
  certificateController.getCertificateSas
);
router.put('/certificates/update-to-public', authMiddleware(), certificateController.updateToPublic);


// Lekérés certNo alapján
router.get('/certificates/:certNo', authMiddleware(), certificateController.getCertificateByCertNo);

// Törlés
router.delete('/certificates/:id', authMiddleware(), certificateController.deleteCertificate);

// Módosítás
router.put('/certificates/:id', authMiddleware(), certificateController.updateCertificate);

module.exports = router;