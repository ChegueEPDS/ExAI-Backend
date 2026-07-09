const express = require('express');
const visionController = require('../controllers/visionController');
const { memoryUpload } = require('../middlewares/uploadFactory');

const router = express.Router();

// Multer beállítások (memóriában tároljuk a fájlokat)
const upload = memoryUpload({ fileSizeMb: 15, files: 1, fields: 20 });

// Feltöltés endpoint
router.post('/upload', upload.single('image'), visionController.uploadImage);

// Elemzés endpoint
router.post('/analyze', visionController.analyzeImages);

module.exports = router;
