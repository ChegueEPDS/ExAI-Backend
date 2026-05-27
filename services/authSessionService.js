const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const User = require('../models/user');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');
const Session = require('../models/session');
const { computePermissions, getEffectiveProfessions } = require('../helpers/rbac');

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';

function mustJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET');
  return secret;
}

function parseDurationMs(input, fallbackMs) {
  const raw = String(input || '').trim();
  if (!raw) return fallbackMs;
  const m = raw.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (multipliers[unit] || 1);
}

function accessTtl(clientType) {
  if (clientType === 'mobile') {
    return process.env.ACCESS_TOKEN_TTL_MOBILE || process.env.JWT_EXPIRES_IN_MOBILE_ACCESS || '15m';
  }
  return process.env.ACCESS_TOKEN_TTL_WEB || process.env.JWT_EXPIRES_IN_WEB || process.env.JWT_EXPIRES_IN || '15m';
}

function refreshTtlMs(clientType) {
  if (clientType === 'mobile') {
    return parseDurationMs(process.env.REFRESH_TOKEN_TTL_MOBILE || '30d', 30 * 86_400_000);
  }
  return parseDurationMs(process.env.REFRESH_TOKEN_TTL_WEB || '24h', 24 * 3_600_000);
}

function cookieSecure(req) {
  if (String(process.env.AUTH_COOKIE_SECURE || '').trim()) {
    return String(process.env.AUTH_COOKIE_SECURE).toLowerCase() === 'true';
  }
  return process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function cookieSameSite() {
  const v = String(process.env.AUTH_COOKIE_SAMESITE || 'lax').toLowerCase();
  return ['lax', 'strict', 'none'].includes(v) ? v : 'lax';
}

function cookieOptions(req, maxAge, httpOnly = true) {
  return {
    httpOnly,
    secure: cookieSecure(req),
    sameSite: cookieSameSite(),
    path: '/',
    maxAge,
  };
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function getTenantMeta(tenantId) {
  if (!tenantId) return { name: null, type: null, professionRbacEnabled: false };
  const t = await Tenant.findById(tenantId).lean().select('name type professionRbacEnabled plan seats seatsManaged');
  return t
    ? {
        name: t.name || null,
        type: t.type || null,
        professionRbacEnabled: Boolean(t.professionRbacEnabled),
        tenant: t,
      }
    : { name: null, type: null, professionRbacEnabled: false, tenant: null };
}

async function getSubscriptionSnapshot(tenantId) {
  if (!tenantId) return null;

  const t = await Tenant.findById(tenantId).lean().select(
    'name type plan seats seatsManaged stripeCustomerId stripeSubscriptionId'
  );
  if (!t) return null;

  const base = {
    tenantName: t.name || null,
    tenantType: t.type || null,
    plan: t.plan || 'free',
    seats: {
      max: t.seats?.max ?? 0,
      used: t.seats?.used ?? 0,
    },
    seatsManaged: t.seatsManaged || 'stripe',
  };

  const sub = await Subscription.findOne({ tenantId }).lean().select('tier status seatsPurchased updatedAt');
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
      },
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
    },
  };
}

async function buildUserContext(user, session = null) {
  const tenantId = String(user.tenantId || session?.tenantId || '');
  const meta = await getTenantMeta(tenantId);
  const subscription = await getSubscriptionSnapshot(tenantId);
  const professionRbacEnabled = Boolean(meta.professionRbacEnabled);
  const effectiveProfessions = professionRbacEnabled
    ? getEffectiveProfessions({ role: user.role, professions: user.professions })
    : ['manager'];
  const permissions = professionRbacEnabled
    ? computePermissions({ role: user.role, professions: effectiveProfessions })
    : ['*:*'];
  const plan =
    (subscription && (subscription.plan || subscription.tier)) ||
    meta.tenant?.plan ||
    null;

  return {
    id: String(user._id),
    userId: String(user._id),
    role: user.role,
    tenantId,
    tenantName: meta.name || null,
    tenantType: meta.type || null,
    nickname: user.nickname || null,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    azureId: user.azureId || null,
    professionRbacEnabled,
    professions: effectiveProfessions,
    permissions,
    subscription,
    plan,
    sessionId: session ? String(session._id) : null,
  };
}

async function signAccessToken(user, session) {
  const ctx = await buildUserContext(user, session);
  const payload = {
    sub: ctx.userId,
    userId: ctx.userId,
    sid: String(session._id),
    role: ctx.role,
    tenantId: ctx.tenantId,
    tenantName: ctx.tenantName,
    tenantType: ctx.tenantType,
    nickname: ctx.nickname,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    azureId: ctx.azureId,
    professionRbacEnabled: ctx.professionRbacEnabled,
    professions: ctx.professions,
    permissions: ctx.permissions,
    subscription: ctx.subscription,
    type: 'access',
    typ: 'access',
    aud: process.env.JWT_AUDIENCE || 'atex-api',
    iss: process.env.JWT_ISSUER || 'atex-backend',
    jti: randomToken(16),
    v: 4,
  };
  return jwt.sign(payload, mustJwtSecret(), { expiresIn: accessTtl(session.clientType) });
}

async function createSession({ user, clientType, req }) {
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + refreshTtlMs(clientType));
  const session = await Session.create({
    userId: user._id,
    tenantId: user.tenantId,
    clientType,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 500),
    ip: String(req?.ip || req?.connection?.remoteAddress || ''),
  });
  const accessToken = await signAccessToken(user, session);
  const userContext = await buildUserContext(user, session);
  return { session, accessToken, refreshToken, user: userContext };
}

async function rotateRefreshToken({ refreshToken, req }) {
  const session = await Session.findOne({
    refreshTokenHash: hashToken(refreshToken),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new Error('Invalid refresh token');

  const user = await User.findById(session.userId);
  if (!user || !user.tenantId) throw new Error('Invalid session user');

  const nextRefreshToken = randomToken();
  session.refreshTokenHash = hashToken(nextRefreshToken);
  session.lastSeenAt = new Date();
  session.userAgent = String(req?.headers?.['user-agent'] || session.userAgent || '').slice(0, 500);
  session.ip = String(req?.ip || req?.connection?.remoteAddress || session.ip || '');
  await session.save();

  const accessToken = await signAccessToken(user, session);
  const userContext = await buildUserContext(user, session);
  return { session, accessToken, refreshToken: nextRefreshToken, user: userContext };
}

async function authenticateAccessToken(token) {
  const decoded = jwt.verify(token, mustJwtSecret(), {
    audience: process.env.JWT_AUDIENCE || 'atex-api',
    issuer: process.env.JWT_ISSUER || 'atex-backend',
  });
  if (decoded.type !== 'access' && decoded.typ !== 'access') throw new Error('Wrong token type');
  if (!decoded.sid) throw new Error('Missing session');

  const session = await Session.findOne({
    _id: decoded.sid,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new Error('Session revoked or expired');

  const user = await User.findById(session.userId).lean();
  if (!user || !user.tenantId) throw new Error('Invalid session user');
  const userContext = await buildUserContext(user, session);
  return { decoded, session, user: userContext };
}

async function revokeSession(sessionId) {
  if (!sessionId) return;
  await Session.findByIdAndUpdate(sessionId, { revokedAt: new Date() });
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  await Session.findOneAndUpdate(
    { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    { revokedAt: new Date() }
  );
}

function setAuthCookies(res, req, result) {
  const refreshMs = Math.max(0, new Date(result.session.expiresAt).getTime() - Date.now());
  const accessMs = parseDurationMs(accessTtl('web'), 15 * 60_000);
  const csrf = randomToken(24);
  res.cookie(ACCESS_COOKIE, result.accessToken, cookieOptions(req, accessMs, true));
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions(req, refreshMs, true));
  res.cookie(CSRF_COOKIE, csrf, cookieOptions(req, refreshMs, false));
}

function clearAuthCookies(res, req) {
  const opts = cookieOptions(req, 0, true);
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
  res.clearCookie(CSRF_COOKIE, cookieOptions(req, 0, false));
}

function getRefreshTokenFromRequest(req) {
  const cookies = parseCookies(req);
  return (
    req.body?.refreshToken ||
    req.headers?.['x-refresh-token'] ||
    cookies[REFRESH_COOKIE] ||
    null
  );
}

function getAccessTokenFromRequest(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer && bearer !== 'cookie-session') return { token: bearer, source: 'bearer' };
  }
  const cookies = parseCookies(req);
  if (cookies[ACCESS_COOKIE]) return { token: cookies[ACCESS_COOKIE], source: 'cookie' };
  return { token: null, source: null };
}

function validateCsrf(req, tokenSource) {
  if (String(process.env.AUTH_REQUIRE_CSRF || 'false').toLowerCase() !== 'true') return true;
  if (tokenSource !== 'cookie') return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return true;
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  return Boolean(cookieToken && headerToken && String(cookieToken) === String(headerToken));
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  authenticateAccessToken,
  buildUserContext,
  clearAuthCookies,
  createSession,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  revokeSession,
  revokeRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  signAccessToken,
  validateCsrf,
};
