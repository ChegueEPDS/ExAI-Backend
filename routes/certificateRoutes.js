const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');
const authMiddleware = require('../middlewares/authMiddleware');
const azureBlob = require('../services/azureBlobService'); // <-- SAS-hoz kell

// Tanúsítvány feltöltés
router.post('/certificates/upload', authMiddleware(), certificateController.uploadCertificate);

// ATEX preview (server-side OCR + AI; no save, no blob upload)
router.post('/certificates/preview-atex', authMiddleware(), certificateController.previewAtex);

// Listázás
router.get('/certificates', authMiddleware(), certificateController.getCertificates);
router.get('/certificates/public', authMiddleware(), certificateController.getPublicCertificates);

// Adopt / Unadopt
router.post('/certificates/:id/adopt', authMiddleware(), certificateController.adoptPublic);
router.delete('/certificates/:id/adopt', authMiddleware(), certificateController.unadoptPublic);

// SAS link generálás tanúsítvány letöltéséhez
// FONTOS: ez a route legyen MINDEN dinamikus (:param) route ELŐTT!
router.get('/cert-sas', authMiddleware(), async (req, res) => {
  try {
    const { blobPath } = req.query;
    if (!blobPath) {
      return res.status(400).json({ error: 'Missing blobPath' });
    }

    console.log('[SAS] request for blobPath =', blobPath);

    // (Opcionális) ellenőrzés: létezik-e a blob — ha nem, adjunk 404-et beszédes üzenettel
    if (typeof azureBlob.exists === 'function') {
      try {
        const ok = await azureBlob.exists(blobPath);
        if (!ok) {
          return res.status(404).json({ error: 'Blob not found', blobPath });
        }
      } catch (e) {
        console.warn('[SAS] exists() check failed, continuing without it:', e?.message || e);
      }
    }

    const sasUrl = await azureBlob.getReadSasUrl(blobPath, {
      ttlSeconds: 300, // 5 perc érvényesség
      filename: blobPath.split('/').pop()
    });

    return res.json({ url: sasUrl });
  } catch (err) {
    console.error('Error generating SAS URL:', err);
    return res.status(500).json({ error: 'Failed to generate SAS URL' });
  }
});
router.put('/certificates/update-to-public', authMiddleware(), certificateController.updateToPublic);


// Lekérés certNo alapján
router.get('/certificates/:certNo', authMiddleware(), certificateController.getCertificateByCertNo);

// Törlés
router.delete('/certificates/:id', authMiddleware(), certificateController.deleteCertificate);

// Módosítás
router.put('/certificates/:id', authMiddleware(), certificateController.updateCertificate);

module.exports = router;