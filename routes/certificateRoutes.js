const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');
const authMiddleware = require('../middlewares/authMiddleware'); // Importáljuk az autentikációs middleware-t


router.post('/certificates/upload', certificateController.uploadCertificate);
router.get('/certificates', authMiddleware(), certificateController.getCertificates);
router.get('/certificates/:certNo', authMiddleware(), certificateController.getCertificateByCertNo);
router.delete('/certificates/:id', certificateController.deleteCertificate);
router.put('/certificates/:id', certificateController.updateCertificate);

module.exports = router;