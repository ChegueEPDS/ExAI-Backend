const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const axios = require('axios');
const User = require('../models/user');

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0/me';

// 🔹 **Felhasználó regisztráció (normál email/jelszó)**
exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { firstName, lastName, email, password, nickname, company, role } = req.body;

  try {
    console.log("🔹 Regisztráció indítása...");
    console.log(`🔹 Bejövő adatok: ${JSON.stringify(req.body)}`);

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log("❌ A felhasználó már létezik az adatbázisban!");
      return res.status(400).json({ error: 'User already exists' });
    }

    console.log("🔹 Jelszó hash-elés előtt. Eredeti jelszó:", password);
    
    // 🔹 HASH generálás
    const hashedPassword = await bcrypt.hash(password, 10);
    
    console.log("🔹 Hash-elés után. Generált hash:", hashedPassword);

    const user = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,  // ⬅️ Itt mentjük el a hash-t!
      role: role || 'User',
      nickname, 
      company: company || 'default',
    });

    await user.save();
    console.log("✅ Felhasználó sikeresen regisztrálva!");

    res.status(201).json({ message: 'User registered successfully', hashedPassword });
  } catch (error) {
    console.error("❌ Regisztrációs hiba:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// 🔹 **Normál bejelentkezés (email + jelszó)**
exports.login = async (req, res) => {
  const { email, password } = req.body;
  console.log("🔹 Bejelentkezési kísérlet:", email, password); // Debug

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.log("❌ Felhasználó nem található:", email);
      return res.status(400).json({ error: 'User not found with this email' });
    }

    console.log("🔹 Tárolt jelszó hash az adatbázisban:", user.password);

    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log("🔹 Jelszó helyes?", isPasswordValid);

    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Incorrect password' });
    }

    const token = jwt.sign(
      { userId: user._id, nickname: user.nickname, role: user.role, company: user.company, lastName: user.lastName },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log("✅ Sikeres bejelentkezés, JWT token generálva:", token);
    res.status(200).json({ token });
  } catch (error) {
    console.error("❌ Login hiba:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// 🔹 **Microsoft bejelentkezés (MSAL token validálás és JWT generálás)**
exports.microsoftLogin = async (req, res) => {
  try {
      console.log('🔹 Microsoft bejelentkezés megkezdve...');

      const { accessToken } = req.body;

      if (!accessToken) {
          console.error('❌ Hiányzó access token!');
          return res.status(400).json({ error: 'Access token is required' });
      }

      console.log('✅ Kapott Microsoft accessToken:', accessToken.slice(0, 20) + '...');

      // 🔹 Microsoft token dekódolása
      const decodedToken = jwt.decode(accessToken);

      if (!decodedToken) {
          console.error('❌ Érvénytelen Microsoft token.');
          return res.status(401).json({ error: 'Invalid Microsoft token' });
      }

      console.log('🔍 Microsoft token dekódolva:', decodedToken);

      // 🔹 Felhasználói adatok kinyerése a tokenből
      const email = decodedToken.upn || decodedToken.email || null;
      const firstName = decodedToken.given_name || 'N/A';
      const lastName = decodedToken.family_name || 'N/A';
      const azureId = decodedToken.oid; // **Azure AD egyedi felhasználói azonosító**
      const tenantId = decodedToken.tid;
      const company = email ? email.split('@')[1]?.split('.')[0] || 'default' : 'default';

      console.log(`🔹 Felhasználó azonosítva:
        Email: ${email || 'Nincs email'}
        Név: ${firstName} ${lastName}
        Azure ID: ${azureId}
        Tenant ID: ${tenantId}
        Vállalat: ${company}`);

      if (!azureId) {
          console.error('❌ Nincs Azure ID a tokenben! Nem tudunk egyedi felhasználót létrehozni.');
          return res.status(400).json({ error: 'Azure ID is missing in the token' });
      }

      // 🔹 Ellenőrizzük, hogy a felhasználó létezik-e már
      let user = await User.findOne({ azureId });

      if (!user) {
          console.log(`✅ Új felhasználó létrehozása: ${email || 'Nincs email'}`);

          user = new User({
              azureId,
              firstName,
              lastName,
              email: email || `no-email-${azureId}@microsoft.com`,
              company,
              role: 'User',
              password: 'microsoft-auth',
              tenantId
          });

          await user.save();
          console.log(`✅ Felhasználó sikeresen létrehozva: ${user.email}, vállalat: ${user.company}`);
      } else {
          console.log(`🔹 Felhasználó már létezik: ${user.email}, vállalat: ${user.company}`);
      }

      // 🔹 **JWT token létrehozása az azureId mezővel**
      const token = jwt.sign(
          {
              userId: user._id,
              email: user.email,
              role: user.role,
              company: user.company,
              firstName: user.firstName,
              lastName: user.lastName,
              azureId: user.azureId // **Azure ID beillesztése a tokenbe**
          },
          process.env.JWT_SECRET,
          { expiresIn: '1h' }
      );

      console.log('✅ JWT token generálva:', token);
      res.status(200).json({ token });

  } catch (error) {
      console.error('❌ Microsoft login hiba:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
};

// 🔹 **Token megújítása**
exports.renewToken = (req, res) => {
  const oldToken = req.headers.authorization?.split(' ')[1];
  if (!oldToken) {
    return res.status(401).json({ error: 'Token is required' });
  }

  try {
    const decoded = jwt.verify(oldToken, JWT_SECRET);

    const newToken = jwt.sign(
      { userId: decoded.userId, nickname: decoded.nickname, role: decoded.role, company: decoded.company },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ token: newToken });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// 🔹 **Kilépés**
exports.logout = (req, res) => {
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