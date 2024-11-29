const express = require('express');
const multer = require('multer');
const { processImage } = require('../controllers/fireController');

const router = express.Router();

// Fájlok tárolása egy helyi mappában
const upload = multer({ dest: 'uploads/' });

// Végpont képfeldolgozáshoz
router.post('/analyze', upload.single('image'), processImage);

module.exports = router;