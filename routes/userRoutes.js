const express = require('express');
const { getUserProfile, updateUserProfile } = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// Fetch user profile
router.get('/user/:userId', authMiddleware(['Admin', 'User']), getUserProfile);

// Update user profile
router.put('/user/:userId', authMiddleware(['Admin', 'User']), updateUserProfile);

module.exports = router;
