// routes/userRoutes.js

const express = require('express');
const { getUserProfile, updateUserProfile, listUsers, getMyDownloadQuota, moveUserToTenant, deleteUser } = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// List users (Admin: same tenant, SuperAdmin: all)
router.get('/users', authMiddleware(['Admin', 'SuperAdmin']), listUsers);

// Fetch user profile
router.get('/user/:userId', authMiddleware(['Admin', 'User']), getUserProfile);

// Update user profile
router.put('/user/:userId', authMiddleware(['Admin', 'User']), updateUserProfile);

// Delete user profile
router.delete('/user/:userId', authMiddleware (['Admin', 'SuperAdmin']), deleteUser)

// Get my download quota
router.get('/user/me/quota', authMiddleware(), getMyDownloadQuota);

// Move user to another tenant (Admin: same tenant, SuperAdmin: all)
router.post('/users/move-to-tenant/:toTenantId', authMiddleware(['Admin', 'SuperAdmin']), moveUserToTenant );

module.exports = router;
