// routes/authRoutes.js
const express = require('express');
const { body } = require('express-validator');
const { register, login, logout, renewToken, microsoftLogin } = require('../controllers/authController');

// mindkét forma működik, de most named exportot használunk
const { requireAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

// Normál regisztráció
router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], register);

// Normál bejelentkezés
router.post('/login', login);

// Microsoft bejelentkezés (egyszer!)
router.post('/microsoft-login', microsoftLogin);

// Token megújítása (auth kell)
router.post('/renew-token', requireAuth, renewToken);

// Kijelentkezés (auth kell)
router.post('/logout', requireAuth, logout);

module.exports = router;