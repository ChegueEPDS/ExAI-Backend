const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middlewares/authMiddleware');
const { downloadYearbook2026 } = require('../controllers/downloadController');

// Auth required: only logged in users can download
router.get('/downloads/yearbook-2026', requireAuth, downloadYearbook2026);

module.exports = router;

