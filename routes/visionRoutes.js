const express = require('express');
const multer = require('multer');
const visionController = require('../controllers/visionController');

const router = express.Router();

// Multer beállítások (memóriában tároljuk a fájlokat)
const upload = multer({ storage: multer.memoryStorage() });

// Feltöltés endpoint
router.post('/upload', upload.single('image'), visionController.uploadImage);

// Elemzés endpoint
router.post('/analyze', visionController.analyzeImages);

module.exports = router;