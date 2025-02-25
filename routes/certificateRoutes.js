const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');

router.post('/certificates/upload', certificateController.uploadCertificate);
router.get('/certificates', certificateController.getCertificates);
router.get('/certificates/:certNo', certificateController.getCertificateByCertNo);
router.delete('/certificates/:id', certificateController.deleteCertificate);
router.put('/certificates/:id', certificateController.updateCertificate);

module.exports = router;