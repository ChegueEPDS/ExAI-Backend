const express = require('express');
const router = express.Router();
const { sendTestEmail } = require('../controllers/mailController');
const auth = require('../middlewares/authMiddleware');

// csak jogosultaknak (beállíthatod pl. Admin/SuperAdminra)
router.post('/mail/send', auth(['Admin', 'SuperAdmin']), sendTestEmail);

module.exports = router;