const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');

// Tanúsítvány feltöltés
router.post('/certificates/upload', certificateController.uploadCertificate);

// Tanúsítványok lekérdezése
router.get('/certificates', certificateController.getCertificates);
router.get('/certificates/:certNo', certificateController.getCertificateByCertNo);

module.exports = router;