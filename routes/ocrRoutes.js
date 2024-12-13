
// ocrRoutes.js
const express = require('express');
const router = express.Router();
const imgOcrController = require('../controllers/imgOcrController');


// Route for uploading images
router.post('/plate', imgOcrController.uploadImage);

module.exports = router;