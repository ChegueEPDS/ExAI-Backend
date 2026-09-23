// routes/userRoutes.js

const express = require('express');
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
const { memoryUpload } = require('../middlewares/uploadFactory');
const emailPreferenceController = require('../controllers/emailPreferenceController');
const userPreferenceController = require('../controllers/userPreferenceController');

const router = express.Router();

// Signature / tenant logo upload handled in-memory; max ~2 MB per image
const upload = memoryUpload({ fileSizeMb: 2, files: 2, fields: 40 });

// Public Brevo callback; protected by BREVO_WEBHOOK_SECRET.
router.post('/webhooks/brevo/marketing', express.json(), emailPreferenceController.handleBrevoMarketingWebhook);

router.get('/user/me/email-preferences', authMiddleware(), emailPreferenceController.getMyEmailPreferences);
router.put('/user/me/email-preferences', authMiddleware(), express.json(), emailPreferenceController.updateMyEmailPreferences);
router.get('/user/me/preferences', authMiddleware(), userPreferenceController.getMyPreferences);
router.put('/user/me/preferences', authMiddleware(), express.json(), userPreferenceController.updateMyPreferences);

// List users (Admin: same tenant, SuperAdmin: all)
router.get('/users', authMiddleware(['Admin', 'SuperAdmin']), listUsers);

// Fetch user profile
router.get('/user/:userId', authMiddleware(), getUserProfile);

// Update user profile (basic fields + optional signature image / admin tenant logo)
router.put(
  '/user/:userId',
  authMiddleware(),
  upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'tenantLogo', maxCount: 1 }
  ]),
  updateUserProfile
);

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

// Manual reward email (SuperAdmin only) - also sets baseline for future auto rewards
router.post(
  '/users/:userId/contribution-reward/manual-send',
  authMiddleware(['SuperAdmin']),
  manualSendContributionReward
);

module.exports = router;
