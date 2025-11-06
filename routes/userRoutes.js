// routes/userRoutes.js

const express = require('express');
const { getUserProfile, updateUserProfile, listUsers, getMyDownloadQuota, moveUserToTenant, deleteUser, createPaidTenantUser } = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// List users (Admin: same tenant, SuperAdmin: all)
router.get('/users', authMiddleware(['Admin', 'SuperAdmin']), listUsers);

// Fetch user profile
router.get('/user/:userId', authMiddleware(), getUserProfile);

// Update user profile
router.put('/user/:userId', authMiddleware(), updateUserProfile);

// Delete user profile
router.delete('/user/:userId', authMiddleware (['Admin', 'SuperAdmin']), deleteUser)

// Get my download quota
router.get('/user/me/quota', authMiddleware(), getMyDownloadQuota);

// Move user to another tenant (Admin: same tenant, SuperAdmin: all)
router.post('/users/move-to-tenant/:toTenantId', authMiddleware(['Admin', 'SuperAdmin']), moveUserToTenant );

// routes/userRoutes.js  -- ADD
router.post(
  '/admin/create-paid-tenant-user',
  authMiddleware(['Admin','SuperAdmin']),
  createPaidTenantUser
);

module.exports = router;
