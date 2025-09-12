const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/user');
const Tenant = require('../models/tenant');

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

/**
 * ------------------------------------------------------------
 * AUTH CONTROLLER (tenant-first, company kivezetve)
 * - Regisztrációnál és login-nál opcionális: req.body.tenantName
 *   - ha meg van adva: ahhoz a tenant-hoz kapcsoljuk a usert (létrehozzuk, ha nem létezik)
 *   - ha nincs megadva és a usernek nincs tenantja: személyes (personal) tenantot kap
 * - JWT payload: tenantId, tenantName, tenantType + user meta
 * - company mezőt többé nem írjuk (legacy-t meghagyjuk, de nem használjuk)
 * ------------------------------------------------------------
 */

// --------- Helpers ---------

function normalizeName(s) {
  return String(s || '').trim();
}

async function getTenantMeta(tenantId) {
  if (!tenantId) return { name: null, type: null };
  const t = await Tenant.findById(tenantId).lean().select('name type');
  return t ? { name: t.name || null, type: t.type || null } : { name: null, type: null };
}

async function getOrCreateTenantByName(tenantNameRaw, type = 'company', ownerUserId = null) {
  const name = normalizeName(tenantNameRaw);
  if (!name) return null;

  // (opcionális) kialakíthatsz unique indexet a Tenant.name-re
  let t = await Tenant.findOne({ name });
  if (!t) {
    t = await Tenant.create({ name, type, ownerUserId: ownerUserId || undefined });
  }
  return t;
}

/**
 * Biztosít tenantot a user számára:
 * - ha már van tenantId → visszaadjuk
 * - ha van tenantName → ahhoz csatlakoztatjuk (vagy létrehozzuk)
 * - különben personal tenantot kap
 */
async function ensureTenantForUserFromName(user, tenantName) {
  if (user.tenantId) return { user, tenant: await Tenant.findById(user.tenantId).lean() };

  let tenant = null;
  if (tenantName) {
    tenant = await getOrCreateTenantByName(tenantName, 'company');
  } else {
    const personalName = `Personal — ${user.email || user._id}`;
    tenant = await getOrCreateTenantByName(personalName, 'personal', user._id);
  }

  user.tenantId = tenant._id;
  await user.save();
  return { user, tenant };
}

function signAccessToken(user, { tenantName = null, tenantType = null } = {}) {
  const payload = {
    sub: String(user._id),
    userId: String(user._id),
    role: user.role,
    tenantId: String(user.tenantId),
    tenantName: tenantName || null,
    tenantType: tenantType || null,
    nickname: user.nickname || null,
    firstName: user.firstName,
    lastName: user.lastName,
    azureId: user.azureId || null,
    type: 'access',
    v: 1,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

// ----------------------
// 🔹 Felhasználó regisztráció (email + jelszó)
//   Body elvárt / opcionális mezők: firstName, lastName, email, password, nickname?, role?, tenantName?
// ----------------------
exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { firstName, lastName, email, password, nickname, role, tenantName } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Jelszó hash (a User pre-save is hashel, de itt is biztonságos)
    const hashedPassword = await bcrypt.hash(password, 10);

    // 1) user létrehozása company nélkül
    let user = await User.create({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role: role || 'User',
      nickname: nickname || undefined,
      // company: undefined  // kivezetve
    });

    // 2) tenant biztosítása tenantName alapján (vagy personal)
    const ensured = await ensureTenantForUserFromName(user, tenantName);
    user = ensured.user;

    const meta = await getTenantMeta(user.tenantId);
    const token = signAccessToken(user, { tenantName: meta.name, tenantType: meta.type });

    return res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        email: user.email,
        tenantId: user.tenantId,
        tenantName: meta.name,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        nickname: user.nickname || null,
      },
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 Normál bejelentkezés (email + jelszó)
//   Body: email, password, tenantName?  (ha a usernek még nincs tenantja, ezzel lehet csatlakozni/céget választani)
// ----------------------
exports.login = async (req, res) => {
  const { email, password, tenantName } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'User not found with this email' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Incorrect password' });
    }

    // Ha régi usernek nincs tenantja → állítsuk be tenantName alapján, különben personal
    if (!user.tenantId) {
      const ensured = await ensureTenantForUserFromName(user, tenantName);
      user = ensured.user;
    }

    const meta = await getTenantMeta(user.tenantId);
    const token = signAccessToken(user, { tenantName: meta.name, tenantType: meta.type });
    return res.status(200).json({ token });
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 Microsoft bejelentkezés (MSAL token validálás és JWT generálás)
//   Body: { accessToken, tenantName? }
//   - Ha tenantName érkezik és a usernek nincs tenantja → ahhoz csatlakozik (vagy létrehozzuk)
//   - Egyébként personal tenant
// ----------------------
exports.microsoftLogin = async (req, res) => {
  try {
    const { accessToken, tenantName } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Access token is required' });
    }

    // Microsoft JWT dekódolás (lokális decode)
    const decodedToken = jwt.decode(accessToken);
    if (!decodedToken) {
      return res.status(401).json({ error: 'Invalid Microsoft token' });
    }

    const email = decodedToken.upn || decodedToken.email || null;
    const firstName = decodedToken.given_name || 'N/A';
    const lastName = decodedToken.family_name || 'N/A';
    const azureId = decodedToken.oid; // Azure AD egyedi ID

    if (!azureId) {
      return res.status(400).json({ error: 'Azure ID is missing in the token' });
    }

    let user = await User.findOne({ azureId });
    if (!user) {
      user = await User.create({
        azureId,
        firstName,
        lastName,
        email: email || `no-email-${azureId}@microsoft.com`,
        role: 'User',
        password: 'microsoft-auth', // pre-save hash-eli
        // company: undefined
      });
    }

    if (!user.tenantId) {
      const ensured = await ensureTenantForUserFromName(user, tenantName);
      user = ensured.user;
    }

    const meta = await getTenantMeta(user.tenantId);
    const token = signAccessToken(user, { tenantName: meta.name, tenantType: meta.type });
    return res.status(200).json({ token });
  } catch (error) {
    console.error('❌ Microsoft login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 Token megújítása
// ----------------------
exports.renewToken = async (req, res) => {
  const oldToken = req.headers.authorization?.split(' ')[1];
  if (!oldToken) {
    return res.status(401).json({ error: 'Token is required' });
  }

  try {
    const decoded = jwt.verify(oldToken, JWT_SECRET);

    // Biztonság kedvéért töltsük be a usert
    let user = await User.findById(decoded.userId || decoded.sub);
    if (!user) return res.status(401).json({ error: 'Invalid token (user missing)' });

    // ha valamiért még nincs tenant → kapjon (personal)
    if (!user.tenantId) {
      const ensured = await ensureTenantForUserFromName(user, null);
      user = ensured.user;
    }

    const meta = await getTenantMeta(user.tenantId);
    const newToken = signAccessToken(user, { tenantName: meta.name, tenantType: meta.type });
    return res.status(200).json({ token: newToken });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ----------------------
// 🔹 Kilépés
// ----------------------
exports.logout = (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) {
        return res.status(500).json({ error: 'Failed to log out' });
      }
      return res.status(200).json({ message: 'Successfully logged out' });
    });
  } else {
    return res.status(200).json({ message: 'Successfully logged out' });
  }
};