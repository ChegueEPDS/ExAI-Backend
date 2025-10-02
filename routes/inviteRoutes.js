// routes/inviteRoutes.js
const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const {
  createInvite,
} = require('../controllers/inviteController');

const router = express.Router();

// Új usert is létrehozó létrehozás (Admin/SuperAdmin)
router.post('/invitations', authMiddleware(['Admin', 'SuperAdmin']), createInvite);


module.exports = router;