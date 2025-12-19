// routes/authRoutes.js
const express = require('express');
const { body } = require('express-validator');
const {
  register,
  login,
  logout,
  renewToken,
  microsoftLogin,
  forgotPassword,
  changePassword,
  verifyEmail,
  resendVerificationEmail
} = require('../controllers/authController');
const captchaVerify = require('../middlewares/captchaMiddleware');

// mindkét forma működik, de most named exportot használunk
const { requireAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], register);

router.post('/login', captchaVerify,login);
router.post('/microsoft-login', microsoftLogin);
router.post('/renew-token', requireAuth, renewToken);
router.post('/logout', requireAuth, logout);
router.post('/auth/forgot-password', captchaVerify, forgotPassword);
router.post('/auth/change-password', requireAuth, changePassword);
router.post('/auth/verify-email', verifyEmail);
router.post('/auth/resend-verification', captchaVerify, resendVerificationEmail);

module.exports = router;
