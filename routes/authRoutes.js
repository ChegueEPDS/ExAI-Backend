// routes/authRoutes.js
const express = require('express');
const {
  login,
  logout,
  me,
  csrf,
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

// Self-service registration is intentionally disabled. Users are provisioned
// by a tenant Admin or SuperAdmin through POST /api/invitations.
router.post('/register', (req, res) => res.status(403).json({
  error: 'Self-service registration is disabled. Ask a tenant administrator to add you.',
}));

router.post('/login', captchaVerify,login);
router.post('/microsoft-login', microsoftLogin);
router.post('/renew-token', renewToken);
router.post('/auth/refresh', renewToken);
router.get('/auth/csrf', csrf);
router.post('/logout', logout);
router.get('/auth/me', requireAuth, me);
router.get('/auth/session', requireAuth, me);
router.post('/auth/forgot-password', captchaVerify, forgotPassword);
router.post('/auth/change-password', requireAuth, changePassword);
router.post('/auth/verify-email', verifyEmail);
router.post('/auth/resend-verification', captchaVerify, resendVerificationEmail);

module.exports = router;
