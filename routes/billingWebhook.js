// routes/billingWebhook.js
const express = require('express');
const router = express.Router();
const { handleStripeWebhook } = require('../controllers/billingWebhookController');

// IMPORTANT: Stripe-hoz RAW body kell!
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

module.exports = router;