const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');

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

const pick = (obj, keys) => keys.reduce((o, k) => { o[k] = obj?.[k]; return o; }, {});

function normalizeName(s) {
  return String(s || '').trim();
}

// --- name helpers (slug + ensure unique) ---
function slugifyTenantName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, '-') // allow a-z, 0-9, dash, underscore, dot (matches model regex)
    .replace(/^-+|-+$/g, '')
    .substring(0, 64) || `tenant-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureUniqueTenantName(base) {
  const raw = base && String(base).trim() ? base : `tenant-${Math.random().toString(36).slice(2, 8)}`;
  let candidate = slugifyTenantName(raw);
  let i = 1;
  while (await Tenant.findOne({ name: candidate })) {
    i += 1;
    candidate = `${slugifyTenantName(raw)}-${i}`.substring(0, 64);
  }
  return candidate;
}

async function createCompanyTenantForTeam({ companyName, seats = 5, ownerUserId }) {
  const base = companyName && String(companyName).trim() ? companyName : 'company';
  const uniqueName = await ensureUniqueTenantName(base);
  const maxSeats = Math.max(5, Number(seats) || 5);

  const tenant = await Tenant.create({
    name: uniqueName,
    type: 'company',
    plan: 'team',
    ownerUserId: ownerUserId ? ownerUserId : undefined,
    seats: { max: maxSeats, used: 1 },
    seatsManaged: 'stripe'
  });
  return tenant;
}

async function getTenantMeta(tenantId) {
  if (!tenantId) return { name: null, type: null };
  const t = await Tenant.findById(tenantId).lean().select('name type');
  return t ? { name: t.name || null, type: t.type || null } : { name: null, type: null };
}

async function getOrCreateTenantByName(tenantNameRaw, type = 'company', ownerUserId = null, opts = {}) {
  // slug + ensure unique to satisfy Tenant.name regex and uniqueness
  const base = tenantNameRaw && String(tenantNameRaw).trim()
    ? tenantNameRaw
    : (type === 'personal' ? `u-${ownerUserId || Date.now()}` : 'company');
  const name = await ensureUniqueTenantName(base);

  let t = await Tenant.findOne({ name });
  if (!t) {
    const isPersonal = String(type) === 'personal';
    t = await Tenant.create({
      name,
      type,
      ownerUserId: ownerUserId || undefined,
      // PERSONAL: enforce valid defaults required by the model
      ...(isPersonal ? { plan: opts.plan || 'free', seats: { max: 1, used: 1 } } : {}),
      // COMPANY: plan must be 'team' by schema rule; do NOT set here (it will be set in billing/manual flows)
    });
  }
  return t;
}

async function getSubscriptionSnapshot(tenantId) {
  if (!tenantId) return null;

  const t = await Tenant.findById(tenantId).lean().select(
    'name type plan seats seatsManaged stripeCustomerId stripeSubscriptionId'
  );
  if (!t) return null;

  const base = {
    tenantName: t.name || null,
    tenantType: t.type || null,          // 'personal' | 'company'
    plan: t.plan || 'free',              // 'free' | 'pro' | 'team'
    seats: pick(t.seats || {}, ['max', 'used']),
    seatsManaged: t.seatsManaged || 'stripe'
  };

  const sub = await Subscription.findOne({ tenantId }).lean().select(
    'tier status seatsPurchased updatedAt'
  );

  if (!sub) {
    return {
      ...base,
      tier: base.plan,
      status: 'active',
      seatsPurchased: base.seats?.max || 0,
      lastUpdate: null,
      flags: {
        isFree: base.plan === 'free',
        isPro: base.plan === 'pro',
        isTeam: base.plan === 'team',
      }
    };
  }

  return {
    ...base,
    tier: sub.tier,
    status: sub.status,
    seatsPurchased: sub.seatsPurchased || 0,
    lastUpdate: sub.updatedAt || null,
    flags: {
      isFree: sub.tier === 'free',
      isPro: sub.tier === 'pro',
      isTeam: sub.tier === 'team',
    }
  };
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
    // company: maradhat a meglévő logika
    tenant = await getOrCreateTenantByName(tenantName, 'company');
  } else {
    // PERSONAL: create or get a slugged personal tenant name and enforce valid defaults
    const personalBase = user.email ? `u-${user.email}` : `u-${user._id}`;
    tenant = await getOrCreateTenantByName(personalBase, 'personal', user._id, { plan: 'free' });
  }

  user.tenantId = tenant._id;
  await user.save();
  return { user, tenant };
}

async function signAccessTokenWithSubscription(user) {
  const meta = await getTenantMeta(user.tenantId);
  const subscription = await getSubscriptionSnapshot(user.tenantId);

  const payload = {
    sub: String(user._id),
    userId: String(user._id),
    role: user.role,
    tenantId: String(user.tenantId),
    tenantName: meta.name || null,
    tenantType: meta.type || null,
    nickname: user.nickname || null,
    firstName: user.firstName,
    lastName: user.lastName,
    azureId: user.azureId || null,
    subscription,     // 🔹 new snapshot field
    type: 'access',
    v: 2,
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
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

  // ⚠️ FIGYELEM: plan/companyName/seats/tenantName mostantól IGNORÁLVA regisztrációnál
  const { firstName, lastName, email, password, nickname, role } = req.body || {};

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // 1) user létrehozása – NINCS subscriptionTier kézzel írva
    let user = await User.create({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role: role || 'User',
      nickname: nickname || undefined,
    });

    // 2) personal + free tenant KÖTELEZŐ
    const personalBase = user.email ? `u-${String(user.email).split('@')[0]}` : `u-${user._id}`;
    // getOrCreateTenantByName gondoskodik róla, hogy a név slug-olva + uniq legyen
    const personalTenant = await getOrCreateTenantByName(personalBase, 'personal', user._id, {
      plan: 'free'
    });

    user.tenantId = personalTenant._id;
    await user.save();

    const token = await signAccessTokenWithSubscription(user);

    return res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        email: user.email,
        tenantId: user.tenantId,
        tenantName: personalTenant.name,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        nickname: user.nickname || null,
      },
      tenant: {
        id: personalTenant._id,
        name: personalTenant.name,
        type: personalTenant.type,
        plan: personalTenant.plan,
        seats: personalTenant.seats,
      }
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

    const token = await signAccessTokenWithSubscription(user);
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

    const token = await signAccessTokenWithSubscription(user);
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
    const decoded = jwt.verify(oldToken, process.env.JWT_SECRET);

    // Biztonság kedvéért töltsük be a usert
    let user = await User.findById(decoded.userId || decoded.sub);
    if (!user) return res.status(401).json({ error: 'Invalid token (user missing)' });

    // ha valamiért még nincs tenant → kapjon (personal)
    if (!user.tenantId) {
      const ensured = await ensureTenantForUserFromName(user, null);
      user = ensured.user;
    }

    const newToken = await signAccessTokenWithSubscription(user);
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