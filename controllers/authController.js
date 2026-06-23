// controllers/authController.js
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');
const Session = require('../models/session');
const mailService = require('../services/mailService');
const { registrationEmailHtml, emailVerificationEmailHtml, forgotPasswordEmailHtml } = require('../services/mailTemplates');
const { resolvePublicBaseUrl, persistPublicBaseUrlIfMissing } = require('../helpers/publicBaseUrl');
const Stripe = require('stripe');
const { ensureStripeCustomerForTenant } = require('../services/stripeCustomerProvisioning');
const { computePermissions, getEffectiveProfessions } = require('../helpers/rbac');
const {
  buildSessionMetadata,
  buildUserContext,
  clearAuthCookies,
  createSession,
  getRefreshTokenFromRequest,
  getRefreshTokenSourceFromRequest,
  revokeSession,
  revokeRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  validateCsrf,
} = require('../services/authSessionService');
const { verifyMicrosoftAccessToken } = require('../services/microsoftTokenVerifier');

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (stripeKey) {
  stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
}

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

// Strong temporary password generator (2-2 lower/upper/digit/special)
function generateTempPassword() {
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const specials = '!@#$%^&*()-_=+[]{};:,.?/';
  const pick = s => s[Math.floor(Math.random() * s.length)];

  let pwd = pick(lowers) + pick(lowers) +
            pick(uppers) + pick(uppers) +
            pick(digits) + pick(digits) +
            pick(specials) + pick(specials);
  // Shuffle
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

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

async function signAccessTokenWithSubscription(user, opts = {}) {
  const meta = await getTenantMeta(user.tenantId);
  const subscription = await getSubscriptionSnapshot(user.tenantId);
  const tenantDoc = await Tenant.findById(user.tenantId).select('professionRbacEnabled').lean();
  const professionRbacEnabled = Boolean(tenantDoc?.professionRbacEnabled);
  const expiresIn =
    (opts && opts.expiresIn) ||
    process.env.JWT_EXPIRES_IN ||
    '1h';

  const effectiveProfessions = professionRbacEnabled
    ? getEffectiveProfessions({ role: user.role, professions: user.professions })
    : ['manager'];
  const permissions = professionRbacEnabled
    ? computePermissions({ role: user.role, professions: effectiveProfessions })
    : ['*:*'];

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
    professionRbacEnabled,
    professions: effectiveProfessions,
    permissions,
    subscription,     // 🔹 new snapshot field
    type: 'access',
    v: 3,
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function getAccessTokenExpiresIn(req) {
  const client = String(req?.headers?.['x-client'] || '').toLowerCase();
  if (client === 'mobile') return process.env.JWT_EXPIRES_IN_MOBILE || '30d';
  return process.env.JWT_EXPIRES_IN_WEB || process.env.JWT_EXPIRES_IN || '1h';
}

function getClientType(req) {
  return String(req?.headers?.['x-client'] || '').toLowerCase() === 'mobile' ? 'mobile' : 'web';
}

function sendAuthResult(req, res, result, extra = {}) {
  if (result.session.clientType === 'web') {
    setAuthCookies(res, req, result);
    return res.status(200).json({ user: result.user, session: result.sessionMeta, ...extra });
  }
  return res.status(200).json({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
    session: result.sessionMeta,
    ...extra,
  });
}

function attachAuthResultToRequest(req, result) {
  const user = result?.user;
  if (!user) return;
  req.user = { ...user, tokenType: 'access' };
  req.userId = user.id || user.userId;
  req.role = user.role;
  req.scope = {
    userId: user.id || user.userId,
    tenantId: user.tenantId,
    tenantName: user.tenantName,
    tenantType: user.tenantType,
    professionRbacEnabled: Boolean(user.professionRbacEnabled),
    plan: user.plan || null,
    sessionId: result?.session ? String(result.session._id) : user.sessionId,
  };
}

async function markInteractiveLogin(user) {
  if (!user?._id) return;
  const lastLoginAt = new Date();
  user.lastLoginAt = lastLoginAt;
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt } });
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
  const {
    firstName,
    lastName,
    email,
    password,
    nickname,
    role,
    desiredPlan,
    desiredSeats,
    desiredCompanyName,
    desiredPromoCode,
    desiredCampaign,
  } = req.body || {};

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailToken = crypto.randomBytes(32).toString('hex');
    const emailTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Opcionális: fizetős csomag kiválasztás regisztrációnál (verifikáció után Stripe-ra irányítás)
    const normalizedDesiredPlan = String(desiredPlan || '').trim().toLowerCase();
    const allowedPlans = new Set(['pro', 'team', 'pro_yearly', 'team_yearly', '']);
    if (!allowedPlans.has(normalizedDesiredPlan)) {
      return res.status(400).json({ error: 'Invalid desiredPlan' });
    }
    const pendingSeatsRaw = Number(desiredSeats);
    const pendingSeats =
      normalizedDesiredPlan.startsWith('team')
        ? (Number.isInteger(pendingSeatsRaw) ? Math.max(5, pendingSeatsRaw) : 5)
        : 1;
    const pendingCompanyName =
      normalizedDesiredPlan.startsWith('team')
        ? String(desiredCompanyName || '').trim()
        : '';
    const pendingPromoCode = String(desiredPromoCode || '').trim();
    const pendingCampaign = String(desiredCampaign || '').trim();
    if (normalizedDesiredPlan.startsWith('team') && !pendingCompanyName) {
      return res.status(400).json({ error: 'desiredCompanyName is required for team plans' });
    }

    // 1) user létrehozása – NINCS subscriptionTier kézzel írva
    let user = await User.create({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role: role || 'User',
      nickname: nickname || undefined,
      emailVerified: false,
      emailVerificationToken: emailToken,
      emailVerificationExpires: emailTokenExpires,
      ...(normalizedDesiredPlan
        ? {
            pendingCheckoutPlan: normalizedDesiredPlan,
            pendingCheckoutSeats: pendingSeats,
            pendingCheckoutCompanyName: pendingCompanyName || undefined,
            pendingCheckoutPromoCode: pendingPromoCode || undefined,
            pendingCheckoutCampaign: pendingCampaign || undefined,
          }
        : {}),
    });

    // 2) personal + free tenant KÖTELEZŐ
    const personalBase = user.email ? `u-${String(user.email).split('@')[0]}` : `u-${user._id}`;
    // getOrCreateTenantByName gondoskodik róla, hogy a név slug-olva + uniq legyen
    const personalTenant = await getOrCreateTenantByName(personalBase, 'personal', user._id, {
      plan: 'free'
    });

    user.tenantId = personalTenant._id;
    await user.save();

    // Fire-and-forget: e-mail verifikációs link
    try {
      const requestBaseUrl = await resolvePublicBaseUrl({ req, tenantId: personalTenant._id });
      await persistPublicBaseUrlIfMissing({ tenantId: personalTenant._id, baseUrl: requestBaseUrl, updatedBy: user._id });
      const appBase = requestBaseUrl || process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
      const verifyUrl = `${appBase.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(emailToken)}`;
      const html = emailVerificationEmailHtml({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        verifyUrl,
        tenantName: personalTenant.name,
        baseUrl: requestBaseUrl || undefined
      });
      mailService.sendMail({
        to: user.email,
        subject: 'Confirm your email for ATEXdb Certs',
        html,
        from: process.env.MAIL_SENDER_UPN
      })
      .then(() => console.log('[mail] Registration verification email sent to', user.email))
      .catch(err => console.warn('[mail] Registration verification e-mail failed:', err?.message || err));
    } catch (err) {
      console.warn('[mail] Registration verification e-mail setup failed:', err?.message || err);
    }

    return res.status(201).json({
      message: 'User registered successfully. Please confirm your email before signing in.',
      requiresEmailVerification: true
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
  const startedAt = Date.now();
  const loginEmail = String(email || '').trim().toLowerCase();
  const stepLog = (step) => {
    console.log(`[auth.login] ${step} email=${loginEmail || '-'} client=${req.headers?.['x-client'] || '-'} elapsedMs=${Date.now() - startedAt}`);
  };

  try {
    stepLog('start');
    if (!email || !password) {
      stepLog('missing-credentials');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    let user = await User.findOne({ email });
    stepLog('user-loaded');
    if (!user) {
      stepLog('user-not-found');
      return res.status(400).json({ error: 'User not found with this email' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    stepLog('password-checked');
    if (!isPasswordValid) {
      stepLog('bad-password');
      return res.status(400).json({ error: 'Incorrect password' });
    }

    if (user.emailVerified === false) {
      stepLog('email-not-verified');
      return res.status(403).json({ error: 'Please verify your email address before logging in.' });
    }

    // Ha régi usernek nincs tenantja → állítsuk be tenantName alapján, különben personal
    if (!user.tenantId) {
      stepLog('ensure-tenant-start');
      const ensured = await ensureTenantForUserFromName(user, tenantName);
      user = ensured.user;
      stepLog('ensure-tenant-done');
    }

    stepLog('sign-token-start');
    const authResult = await createSession({ user, clientType: getClientType(req), req });
    await markInteractiveLogin(user);
    attachAuthResultToRequest(req, authResult);
    stepLog('sign-token-done');
    stepLog('success-response');
    return sendAuthResult(req, res, authResult);
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 E-mail verifikáció
//   Body or query: token
// ----------------------
exports.verifyEmail = async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    let user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;

    const pendingCheckout =
      user.pendingCheckoutPlan && ['pro', 'team', 'pro_yearly', 'team_yearly'].includes(String(user.pendingCheckoutPlan))
        ? {
            plan: String(user.pendingCheckoutPlan),
            seats:
              String(user.pendingCheckoutPlan).startsWith('team')
                ? Math.max(5, Number(user.pendingCheckoutSeats || 5))
                : 1,
            companyName: String(user.pendingCheckoutCompanyName || ''),
            promoCode: String(user.pendingCheckoutPromoCode || ''),
            campaign: String(user.pendingCheckoutCampaign || ''),
          }
        : null;

    // Pending checkout adatot egyszer használjuk (verifikáció után töröljük)
    user.pendingCheckoutPlan = undefined;
    user.pendingCheckoutSeats = undefined;
    user.pendingCheckoutCompanyName = undefined;
    user.pendingCheckoutPromoCode = undefined;
    user.pendingCheckoutCampaign = undefined;
    await user.save();

    if (!user.tenantId) {
      const ensured = await ensureTenantForUserFromName(user, null);
      user = ensured.user;
    }

    // Stripe Customer csak visszaigazolás után (free user esetén is)
    if (stripe && user?.tenantId) {
      try {
        const tenant = await Tenant.findById(user.tenantId);
        if (tenant) {
          await ensureStripeCustomerForTenant({ stripe, tenantDoc: tenant, user });
        }
      } catch (err) {
        console.warn('[stripe] Failed to create customer after email verification:', err?.message || err);
      }
    }

    const authResult = await createSession({ user, clientType: getClientType(req), req });
    attachAuthResultToRequest(req, authResult);

    return sendAuthResult(req, res, authResult, {
      message: 'Email verified successfully',
      pendingCheckout,
    });
  } catch (error) {
    console.error('❌ Email verification error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 Resend email verification
//   Body: { email }
// ----------------------
exports.resendVerificationEmail = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      // ne fedjük fel, ha nincs ilyen user
      return res.status(200).json({
        message: 'If that email exists and is not yet verified, a verification message has been sent.'
      });
    }

    if (user.emailVerified === true) {
      return res.status(400).json({ error: 'Email is already verified.' });
    }

    const emailToken = crypto.randomBytes(32).toString('hex');
    const emailTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    user.emailVerificationToken = emailToken;
    user.emailVerificationExpires = emailTokenExpires;
    await user.save();

    // Tenant név brandinghez
    let tenantName = null;
    if (user.tenantId) {
      try {
        const t = await Tenant.findById(user.tenantId).select('name').lean();
        tenantName = t?.name || null;
      } catch (_) {
        tenantName = null;
      }
    }

    const requestBaseUrl = await resolvePublicBaseUrl({ req, tenantId: user.tenantId || null });
    await persistPublicBaseUrlIfMissing({ tenantId: user.tenantId || null, baseUrl: requestBaseUrl, updatedBy: user._id });
    const appBase = requestBaseUrl || process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
    const verifyUrl = `${appBase.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(emailToken)}`;
    const html = emailVerificationEmailHtml({
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      verifyUrl,
      tenantName: tenantName || undefined,
      baseUrl: requestBaseUrl || undefined
    });

    mailService
      .sendMail({
        to: user.email,
        subject: 'Confirm your email for ATEXdb Certs',
        html,
        from: process.env.MAIL_SENDER_UPN
      })
      .then(() => console.log('[mail] Resend verification email sent to', user.email))
      .catch(err =>
        console.warn('[mail] Resend verification e-mail failed:', err?.message || err)
      );

    return res.status(200).json({
      message: 'Verification email sent. Please check your inbox.'
    });
  } catch (error) {
    console.error('❌ Resend verification email error:', error);
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

    const decodedToken = await verifyMicrosoftAccessToken(accessToken);

    const email = decodedToken.upn || decodedToken.email || decodedToken.preferred_username || null;
    const firstName = decodedToken.given_name || 'N/A';
    const lastName = decodedToken.family_name || 'N/A';
    const azureId = decodedToken.oid || decodedToken.sub; // Azure AD egyedi ID

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

    const authResult = await createSession({ user, clientType: getClientType(req), req });
    await markInteractiveLogin(user);
    attachAuthResultToRequest(req, authResult);
    return sendAuthResult(req, res, authResult);
  } catch (error) {
    console.error('❌ Microsoft login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ----------------------
// 🔹 Token megújítása
// ----------------------
exports.renewToken = async (req, res) => {
  try {
    const refreshToken = getRefreshTokenFromRequest(req);
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token is required' });
    if (getRefreshTokenSourceFromRequest(req) === 'cookie' && !validateCsrf(req, 'cookie')) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    const authResult = await rotateRefreshToken({ refreshToken, req });
    return sendAuthResult(req, res, authResult);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
};

// ----------------------
// 🔹 Kilépés
// ----------------------
exports.logout = async (req, res) => {
  try {
    const refreshToken = getRefreshTokenFromRequest(req);
    if (getRefreshTokenSourceFromRequest(req) === 'cookie' && !validateCsrf(req, 'cookie')) {
      clearAuthCookies(res, req);
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    if (req.scope?.sessionId || req.auth?.sessionId || req.auth?.sid) {
      await revokeSession(req.scope?.sessionId || req.auth?.sessionId || req.auth?.sid);
    } else if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    clearAuthCookies(res, req);
    return res.status(200).json({ message: 'Successfully logged out' });
  } catch {
    clearAuthCookies(res, req);
    return res.status(200).json({ message: 'Successfully logged out' });
  }
};

exports.me = async (req, res) => {
  const session = buildSessionMetadata(req.session || null);
  if (req.auth?.exp) session.accessExpiresAt = new Date(req.auth.exp * 1000).toISOString();
  return res.json({
    user: req.user,
    session,
  });
};

// ----------------------
// 🔹 Forgot Password – generates a new temporary password and emails it
//   Body: { email }
//   Always returns 200 to avoid user enumeration.
// ----------------------
exports.forgotPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      // ne leplezzük le, hogy nincs ilyen user
      return res.status(200).json({ message: 'If that email exists and is verified, a reset message has been sent.' });
    }

    // Nem verifikált felhasználónál ne engedjünk jelszó resetet
    if (user.emailVerified === false) {
      return res.status(400).json({
        error: 'Email is not verified. Please verify your email address before resetting the password.'
      });
    }

    // Generate and set temporary password
    const tempPassword = generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);
    user.password = hashed;
    await user.save();

    // Resolve tenant name (if any) for branding
    let tenantName = null;
    if (user.tenantId) {
      try {
        const t = await Tenant.findById(user.tenantId).select('name').lean();
        tenantName = t?.name || null;
      } catch (_) {
        tenantName = null;
      }
    }

    // Send email with the new temporary password
    const requestBaseUrl = await resolvePublicBaseUrl({ req, tenantId: user.tenantId || null });
    await persistPublicBaseUrlIfMissing({ tenantId: user.tenantId || null, baseUrl: requestBaseUrl, updatedBy: user._id });
    const loginUrl = requestBaseUrl || process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
    const html = forgotPasswordEmailHtml({
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      loginUrl,
      tempPassword,
      tenantName: tenantName || undefined,
      baseUrl: requestBaseUrl || undefined
    });

    // fire-and-forget
    mailService.sendMail({
      to: email,
      subject: 'Your ATEXdb Certs password reset',
      html,
      from: process.env.MAIL_SENDER_UPN
    })
    .then(() => console.log('[mail] Forgot password email sent to', email))
    .catch(err => console.warn('[mail] Forgot password email failed:', err?.message || err));

    return res.status(200).json({ message: 'If that email exists, a reset message has been sent.' });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/auth/change-password
 * Body: { newPassword: string, currentPassword?: string }
 * Auth required
 */
exports.changePassword = async (req, res) => {
  try {
    const userId = req.scope?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    const { newPassword, currentPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || !newPassword.trim()) {
      return res.status(400).json({ message: 'New password is required.' });
    }

    // Alap jelszó policy – igény szerint szigorítható
    const pwd = newPassword.trim();
    const strongEnough =
      pwd.length >= 8 &&
      /[a-z]/.test(pwd) &&
      /[A-Z]/.test(pwd) &&
      /[0-9]/.test(pwd);
    if (!strongEnough) {
      return res.status(400).json({
        message: 'Password is too weak. Use at least 8 characters with upper, lower case and a digit.'
      });
    }

    const user = await User.findById(userId).select('+password'); // ha a sémában select:false volt
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Ha van lokális jelszava a usernek és kaptunk currentPassword-t, akkor ellenőrizzük.
    // (A jelenlegi UI nem kéri a régit, ezért opcionális marad.)
    if (currentPassword && user.password) {
      const ok = await bcrypt.compare(String(currentPassword), String(user.password));
      if (!ok) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
    }

    // Hash + mentés
    const hash = await bcrypt.hash(pwd, 10);
    user.password = hash;
    // ha volt valami flag a kényszerített jelszócserére:
    if (user.forcePasswordChange) user.forcePasswordChange = false;

    await user.save();

    // (Opcionális) – ha szeretnéd a régi session érvénytelenítését, itt megteheted (token blacklist / token ver. bump).

    return res.json({ message: 'Password updated successfully.' });
  } catch (e) {
    console.error('[auth/change-password] error', e);
    return res.status(500).json({ message: 'Failed to change password.' });
  }
};
