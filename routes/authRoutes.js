const express = require('express');
const { body } = require('express-validator');
const { register, login, logout, renewToken, microsoftLogin } = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');


const router = express.Router();

// Normál regisztráció
router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], register);

router.post('/microsoft-login', microsoftLogin);


// **🔹 Normál bejelentkezés**
router.post('/login', login);

// **🔹 Microsoft bejelentkezés JWT generálással**
router.post('/microsoft-login', microsoftLogin);

// Token megújítása
router.post('/renew-token', renewToken);

// Kijelentkezés
router.post('/logout', authMiddleware(['Admin', 'User']), logout);

module.exports = router;