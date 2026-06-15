// routes/inviteRoutes.js
const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const {
  createInvite,
  getJoinInvite,
  acceptJoinInvite,
  rejectJoinInvite,
} = require('../controllers/inviteController');

const router = express.Router();

// Új usert is létrehozó létrehozás (Admin/SuperAdmin)
router.post('/invitations', authMiddleware(['Admin', 'SuperAdmin']), createInvite);
router.get('/invitations/join/:token', getJoinInvite);
router.post('/invitations/join/:token/accept', authMiddleware(), acceptJoinInvite);
router.post('/invitations/join/:token/reject', rejectJoinInvite);


module.exports = router;
