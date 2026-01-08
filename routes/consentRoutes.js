const express = require('express');
const optionalAuth = require('../middlewares/optionalAuth');
const { recordConsentDecision } = require('../controllers/consentController');

const router = express.Router();

// Minimal consent audit log (optional auth)
router.post('/consent', optionalAuth, recordConsentDecision);

module.exports = router;

