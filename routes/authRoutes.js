// routes/authRoutes.js
const express = require('express');
const { body } = require('express-validator');
const { register, login, logout, renewToken, microsoftLogin, forgotPassword, changePassword } = require('../controllers/authController');

// mindkét forma működik, de most named exportot használunk
const { requireAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], register);

router.post('/login', login);
router.post('/microsoft-login', microsoftLogin);
router.post('/renew-token', requireAuth, renewToken);
router.post('/logout', requireAuth, logout);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/change-password', requireAuth, changePassword);

module.exports = router;