const express = require('express');
const { getUserProfile, updateUserProfile, listUsers, getMyDownloadQuota } = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// List users (Admin: same tenant, SuperAdmin: all)
router.get('/users', authMiddleware(['Admin', 'SuperAdmin']), listUsers);

// Fetch user profile
router.get('/user/:userId', authMiddleware(['Admin', 'User']), getUserProfile);

// Update user profile
router.put('/user/:userId', authMiddleware(['Admin', 'User']), updateUserProfile);

// Get my download quota
router.get('/user/me/quota', authMiddleware(), getMyDownloadQuota);

module.exports = router;
