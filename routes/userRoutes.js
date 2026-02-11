// routes/userRoutes.js

const express = require('express');
const multer = require('multer');
const {
  getUserProfile,
  updateUserProfile,
  updateUserProfessions,
  listUsers,
  getMyDownloadQuota,
  moveUserToTenant,
  deleteUser,
  createPaidTenantUser,
  manualSendContributionReward
} = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// Signature upload handled in-memory; max ~2 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }
});

// List users (Admin: same tenant, SuperAdmin: all)
router.get('/users', authMiddleware(['Admin', 'SuperAdmin']), listUsers);

// Fetch user profile
router.get('/user/:userId', authMiddleware(), getUserProfile);

// Update user profile (basic fields + optional signature image)
router.put('/user/:userId', authMiddleware(), upload.single('signature'), updateUserProfile);

// Update user professions (RBAC) - Admin/SuperAdmin
router.put('/users/:userId/professions', authMiddleware(['Admin', 'SuperAdmin']), updateUserProfessions);

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

// Manual reward email (Admin/SuperAdmin) - also sets baseline for future auto rewards
router.post(
  '/users/:userId/contribution-reward/manual-send',
  authMiddleware(['Admin', 'SuperAdmin']),
  manualSendContributionReward
);

module.exports = router;
