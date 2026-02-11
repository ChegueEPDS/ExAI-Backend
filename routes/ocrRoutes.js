
// ocrRoutes.js
const express = require('express');
const router = express.Router();
const imgOcrController = require('../controllers/imgOcrController');
const dataplateController = require('../controllers/dataplateController');


// Route for uploading images
router.post('/plate', imgOcrController.uploadImage);
router.post('/plate/multiple', imgOcrController.uploadMultipleImages);
router.post('/pdfcert', imgOcrController.uploadPdfWithFormRecognizer);  // Új PDF OCR végpont

// Dataplate extraction: Azure OCR + Responses json_schema (industrial-grade)
router.post('/dataplate/extract', ...dataplateController.uploadExtract);


module.exports = router;
