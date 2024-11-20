const express = require('express');
const { body } = require('express-validator');
const { register, login, logout } = require('../controllers/authController'); // Import the logout function
const authMiddleware = require('../middlewares/authMiddleware'); // Import authMiddleware

const router = express.Router();

router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], register);

router.post('/login', login);

router.post('/logout', authMiddleware(['Admin', 'User']), logout); // Protect logout route with authMiddleware

module.exports = router;
