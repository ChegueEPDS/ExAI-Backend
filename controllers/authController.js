const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/user');

// Felhasználó regisztráció
exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { firstName, lastName, email, password, nickname, company } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      role: 'User',  // Alapértelmezett szerepkör
      nickname, // Új mező
      company: company || 'default',
    });

    await user.save();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Bejelentkezés
exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    // Ellenőrizzük, hogy megadtak-e emailt és jelszót
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Felhasználó lekérése az email alapján
    const user = await User.findOne({ email });
    
    // Ellenőrizzük, hogy létezik-e felhasználó az adott email-lel
    if (!user) {
      return res.status(400).json({ error: 'User not found with this email' });
    }

    // Ellenőrizzük a jelszót
    const isPasswordValid = bcrypt.compareSync(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Incorrect password' });
    }

    // JWT létrehozása a userId és nickname alapján
    const token = jwt.sign(
      { userId: user._id, nickname: user.nickname, role: user.role, company:user.company },
      process.env.JWT_SECRET,  // titkos kulcs környezeti változóból
      { expiresIn: '1h' } // Token lejárati ideje (pl. 1 óra)
    );

    // Token visszaküldése a kliensnek
    res.status(200).json({ token });
  } catch (error) {
    // Általános szerverhiba kezelése
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Kilépés
exports.logout = (req, res) => {
  // Session törlése, ha van
  if (req.session) {
    req.session.destroy(err => {
      if (err) {
        return res.status(500).json({ error: 'Failed to log out' });
      }
      res.status(200).json({ message: 'Successfully logged out' });
    });
  } else {
    res.status(200).json({ message: 'Successfully logged out' });
  }
};
