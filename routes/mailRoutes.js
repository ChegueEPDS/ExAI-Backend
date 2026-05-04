const express = require('express');
const router = express.Router();
const { sendTestEmail, listMailboxMessages, getMailboxMessage } = require('../controllers/mailController');
const auth = require('../middlewares/authMiddleware');

// csak jogosultaknak (beállíthatod pl. Admin/SuperAdminra)
router.post('/mail/send', auth(['Admin', 'SuperAdmin']), sendTestEmail);
router.get('/admin/mailbox', auth(['SuperAdmin']), listMailboxMessages);
router.get('/admin/mailbox/:id', auth(['SuperAdmin']), getMailboxMessage);

module.exports = router;
