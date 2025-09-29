// routes/inviteRoutes.js
const express = require('express');
const { authMiddleware } = require('../middlewares/authMiddleware');
const { createInvite, acceptInvite, openInvite, revokeInvite } = require('../controllers/inviteController');

const router = express.Router();

// Meghívó létrehozás (Admin/SuperAdmin)
router.post('/invitations', authMiddleware(['Admin', 'SuperAdmin']), createInvite);

// Meghívó meta leolvasás linkből (nem kötelező auth) – frontend előnézethez
router.get('/invitations/open', openInvite);

// Meghívó elfogadás (AUTH KELL – a belépett user fogadja el; token VAGY code)
router.post('/invitations/accept', authMiddleware(), acceptInvite);

// Meghívó visszavonás (Admin/SuperAdmin)
router.post('/invitations/revoke', authMiddleware(['Admin', 'SuperAdmin']), revokeInvite);

module.exports = router;