const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const User = require('../models/user');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');
const Session = require('../models/session');
const { computePermissions, getEffectiveProfessions } = require('../helpers/rbac');
const tenantAccessService = require('./tenantAccessService');

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';
const authContextCache = new Map();

function authContextCacheTtlMs() {
  const raw = Number(process.env.AUTH_CONTEXT_CACHE_TTL_MS ?? 5000);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 60_000);
}

function pruneAuthContextCache(now = Date.now()) {
  if (authContextCache.size < 1000) return;
  for (const [key, value] of authContextCache.entries()) {
    if (!value || value.expiresAt <= now) authContextCache.delete(key);
  }
}

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
    return process.env.ACCESS_TOKEN_TTL_MOBILE || '15m';
  }
  return process.env.ACCESS_TOKEN_TTL_WEB || '15m';
}

function refreshTtlMs(clientType) {
  if (clientType === 'mobile') {
    return parseDurationMs(process.env.REFRESH_TOKEN_TTL_MOBILE || '30d', 30 * 86_400_000);
  }
  return parseDurationMs(process.env.REFRESH_TOKEN_TTL_WEB || '12h', 12 * 3_600_000);
}

function absoluteTtlMs(clientType) {
  if (clientType === 'mobile') {
    return parseDurationMs(process.env.SESSION_ABSOLUTE_TTL_MOBILE || process.env.REFRESH_TOKEN_TTL_MOBILE || '30d', 30 * 86_400_000);
  }
  return parseDurationMs(process.env.SESSION_ABSOLUTE_TTL_WEB || '24h', 24 * 3_600_000);
}

function minDate(a, b) {
  return new Date(Math.min(new Date(a).getTime(), new Date(b).getTime()));
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
  const opts = {
    httpOnly,
    secure: cookieSecure(req),
    sameSite: cookieSameSite(),
    path: '/',
    maxAge,
  };
  const domain = String(process.env.AUTH_COOKIE_DOMAIN || '').trim();
  if (domain) opts.domain = domain;
  return opts;
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

function ensureSessionCsrfToken(session) {
  if (!session) return null;
  if (session.csrfToken) return session.csrfToken;
  session.csrfToken = randomToken(24);
  return session.csrfToken;
}

async function prepareResponseCsrfToken(req, result = null) {
  const session =
    result?.session?.clientType === 'web'
      ? result.session
      : req?.session?.clientType === 'web'
        ? req.session
        : null;
  const csrfToken = ensureSessionCsrfToken(session);
  if (csrfToken && session?.isModified?.('csrfToken')) {
    await session.save();
  }
  return csrfToken;
}

async function getTenantSnapshot(tenantId) {
  if (!tenantId) return { meta: { name: null, type: null, professionRbacEnabled: false, tenant: null }, subscription: null };

  const tenant = await Tenant.findById(tenantId)
    .lean()
    .select('name type features professionRbacEnabled plan seats seatsManaged stripeCustomerId stripeSubscriptionId');
  if (!tenant) {
    return {
      meta: { name: null, type: null, professionRbacEnabled: false, tenant: null },
      subscription: null,
    };
  }

  const meta = {
    name: tenant.name || null,
    type: tenant.type || null,
    professionRbacEnabled: Boolean(tenant.professionRbacEnabled),
    tenant,
  };

  const base = {
    tenantName: tenant.name || null,
    tenantType: tenant.type || null,
    plan: tenant.plan || 'free',
    seats: {
      max: tenant.seats?.max ?? 0,
      used: tenant.seats?.used ?? 0,
    },
    seatsManaged: tenant.seatsManaged || 'stripe',
  };

  const sub = await Subscription.findOne({ tenantId }).lean().select('tier status seatsPurchased updatedAt');
  if (!sub) {
    return {
      meta,
      subscription: {
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
      },
    };
  }

  return {
    meta,
    subscription: {
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
    },
  };
}

async function buildUserContext(user, session = null) {
  const tenantId = String(user.tenantId || session?.tenantId || '');
  const { meta, subscription } = await getTenantSnapshot(tenantId);
  const tenantFeatures = tenantAccessService.normalizeTenantFeatures(meta.tenant || meta);
  const professionRbacEnabled = Boolean(tenantFeatures.professionRbac);
  const effectiveProfessions = professionRbacEnabled
    ? getEffectiveProfessions({ role: user.role, professions: user.professions })
    : ['manager'];
  let permissions = professionRbacEnabled
    ? computePermissions({ role: user.role, professions: effectiveProfessions })
    : ['*:*'];
  let access = null;
  try {
    const accessCtx = await tenantAccessService.getAccessContext({
      id: String(user._id),
      userId: String(user._id),
      role: user.role,
      tenantId,
      professions: effectiveProfessions,
      permissions,
    });
    permissions = tenantAccessService.getPermissionStringsFromContext(accessCtx, {
      id: String(user._id),
      userId: String(user._id),
      role: user.role,
      tenantId,
      professions: effectiveProfessions,
      permissions,
    });
    access = {
      groupRbacEnabled: Boolean(accessCtx.groupRbacEnabled),
      allSites: Boolean(accessCtx.allSites),
      siteIds: accessCtx.siteIds || [],
      zoneIds: accessCtx.zoneIds || [],
      features: accessCtx.features || tenantFeatures,
    };
  } catch {
    access = {
      groupRbacEnabled: false,
      allSites: true,
      siteIds: [],
      zoneIds: [],
      features: tenantFeatures,
    };
  }
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
    email: user.email || '',
    azureId: user.azureId || null,
    professionRbacEnabled,
    tenantFeatures,
    access,
    professions: effectiveProfessions,
    permissions,
    subscription,
    plan,
    sessionId: session ? String(session._id) : null,
  };
}

async function signAccessToken(user, session, userContext = null) {
  const ctx = userContext || (await buildUserContext(user, session));
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
    tenantFeatures: ctx.tenantFeatures,
    access: ctx.access,
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

function buildSessionMetadata(session, accessToken = null) {
  let accessExpiresAt = null;
  if (accessToken) {
    const decoded = jwt.decode(accessToken);
    if (decoded?.exp) accessExpiresAt = new Date(decoded.exp * 1000).toISOString();
  }
  return {
    sessionId: session ? String(session._id) : null,
    clientType: session?.clientType || null,
    accessExpiresAt,
    refreshExpiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    absoluteExpiresAt: session?.absoluteExpiresAt ? new Date(session.absoluteExpiresAt).toISOString() : null,
    serverNow: new Date().toISOString(),
  };
}

async function createSession({ user, clientType, req }) {
  const refreshToken = randomToken();
  const csrfToken = clientType === 'web' ? randomToken(24) : null;
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + absoluteTtlMs(clientType));
  const expiresAt = minDate(new Date(now + refreshTtlMs(clientType)), absoluteExpiresAt);
  const session = await Session.create({
    userId: user._id,
    tenantId: user.tenantId,
    clientType,
    refreshTokenHash: hashToken(refreshToken),
    csrfToken,
    expiresAt,
    absoluteExpiresAt,
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 500),
    ip: String(req?.ip || req?.connection?.remoteAddress || ''),
  });
  const userContext = await buildUserContext(user, session);
  const accessToken = await signAccessToken(user, session, userContext);
  return {
    session,
    accessToken,
    refreshToken,
    csrfToken,
    user: userContext,
    sessionMeta: buildSessionMetadata(session, accessToken),
  };
}

async function rotateRefreshToken({ refreshToken, req }) {
  const refreshHash = hashToken(refreshToken);
  const now = Date.now();
  const nowDate = new Date(now);
  const graceMs = parseDurationMs(process.env.REFRESH_ROTATION_GRACE || '10s', 10_000);
  let session = await Session.findOne({
    refreshTokenHash: refreshHash,
    revokedAt: null,
    expiresAt: { $gt: nowDate },
  });

  if (!session) {
    session = await Session.findOne({
      previousRefreshTokenHash: refreshHash,
      previousRefreshTokenGraceUntil: { $gt: nowDate },
      revokedAt: null,
      expiresAt: { $gt: nowDate },
    });
    if (!session) throw new Error('Invalid refresh token');
    if (session.clientType !== 'web') throw new Error('Refresh token rotation conflict');

    if (session.absoluteExpiresAt && new Date(session.absoluteExpiresAt).getTime() <= now) {
      await Session.findByIdAndUpdate(session._id, { revokedAt: nowDate });
      throw new Error('Session absolute lifetime expired');
    }

    const user = await User.findById(session.userId);
    if (!user || !user.tenantId) throw new Error('Invalid session user');
    const csrfToken = ensureSessionCsrfToken(session);
    if (csrfToken && session.isModified?.('csrfToken')) {
      await session.save();
    }
    const userContext = await buildUserContext(user, session);
    const accessToken = await signAccessToken(user, session, userContext);
    return {
      session,
      accessToken,
      refreshToken: null,
      csrfToken,
      user: userContext,
      sessionMeta: buildSessionMetadata(session, accessToken),
      refreshRotated: false,
    };
  }

  let absoluteExpiresAt = session.absoluteExpiresAt;
  if (!absoluteExpiresAt) {
    absoluteExpiresAt = new Date(new Date(session.createdAt || now).getTime() + absoluteTtlMs(session.clientType));
  }
  if (new Date(absoluteExpiresAt).getTime() <= now) {
    await Session.findByIdAndUpdate(session._id, { revokedAt: nowDate, absoluteExpiresAt });
    throw new Error('Session absolute lifetime expired');
  }

  const user = await User.findById(session.userId);
  if (!user || !user.tenantId) throw new Error('Invalid session user');

  const nextRefreshToken = randomToken();
  const nextExpiresAt = minDate(new Date(now + refreshTtlMs(session.clientType)), absoluteExpiresAt);
  const updated = await Session.findOneAndUpdate(
    {
      _id: session._id,
      refreshTokenHash: refreshHash,
      revokedAt: null,
      expiresAt: { $gt: nowDate },
    },
    {
      $set: {
        refreshTokenHash: hashToken(nextRefreshToken),
        previousRefreshTokenHash: refreshHash,
        previousRefreshTokenGraceUntil: new Date(now + graceMs),
        lastSeenAt: nowDate,
        expiresAt: nextExpiresAt,
        absoluteExpiresAt,
        userAgent: String(req?.headers?.['user-agent'] || session.userAgent || '').slice(0, 500),
        ip: String(req?.ip || req?.connection?.remoteAddress || session.ip || ''),
      },
    },
    { new: true }
  );
  if (!updated) throw new Error('Refresh token rotation conflict');

  const csrfToken = ensureSessionCsrfToken(updated);
  if (csrfToken && updated.isModified?.('csrfToken')) {
    await updated.save();
  }
  const userContext = await buildUserContext(user, updated);
  const accessToken = await signAccessToken(user, updated, userContext);
  return {
    session: updated,
    accessToken,
    refreshToken: nextRefreshToken,
    csrfToken,
    user: userContext,
    sessionMeta: buildSessionMetadata(updated, accessToken),
    refreshRotated: true,
  };
}

async function authenticateAccessToken(token) {
  const decoded = jwt.verify(token, mustJwtSecret(), {
    audience: process.env.JWT_AUDIENCE || 'atex-api',
    issuer: process.env.JWT_ISSUER || 'atex-backend',
  });
  if (decoded.type !== 'access' && decoded.typ !== 'access') throw new Error('Wrong token type');
  if (!decoded.sid) throw new Error('Missing session');

  const ttlMs = authContextCacheTtlMs();
  const now = Date.now();
  const cacheKey = ttlMs ? `${decoded.sid}:${decoded.sub || decoded.userId || ''}` : '';
  const cached = cacheKey ? authContextCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > now) {
    if (!cached.session?.absoluteExpiresAt || new Date(cached.session.absoluteExpiresAt).getTime() > now) {
      return { decoded, session: cached.session, user: cached.user };
    }
    authContextCache.delete(cacheKey);
  }

  const session = await Session.findOne({
    _id: decoded.sid,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) throw new Error('Session revoked or expired');
  if (session.absoluteExpiresAt && new Date(session.absoluteExpiresAt).getTime() <= Date.now()) {
    await Session.findByIdAndUpdate(session._id, { revokedAt: new Date() });
    throw new Error('Session absolute lifetime expired');
  }

  const user = await User.findById(session.userId).lean();
  if (!user || !user.tenantId) throw new Error('Invalid session user');
  const userContext = await buildUserContext(user, session);
  if (cacheKey && ttlMs) {
    pruneAuthContextCache(now);
    authContextCache.set(cacheKey, {
      expiresAt: now + ttlMs,
      session,
      user: userContext,
    });
  }
  return { decoded, session, user: userContext };
}

async function revokeSession(sessionId) {
  if (!sessionId) return;
  for (const key of authContextCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) authContextCache.delete(key);
  }
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
  res.cookie(ACCESS_COOKIE, result.accessToken, cookieOptions(req, accessMs, true));
  if (result.refreshToken) {
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions(req, refreshMs, true));
  }
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

function getRefreshTokenSourceFromRequest(req) {
  if (req.body?.refreshToken || req.headers?.['x-refresh-token']) return 'bearer';
  const cookies = parseCookies(req);
  if (cookies[REFRESH_COOKIE]) return 'cookie';
  return null;
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

async function validateCsrf(req, tokenSource) {
  const configured = String(process.env.AUTH_REQUIRE_CSRF || '').trim().toLowerCase();
  const required = configured ? configured === 'true' : process.env.NODE_ENV === 'production';
  if (!required) return true;
  if (tokenSource !== 'cookie') return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return true;
  let session =
    req.session ||
    (req.scope?.sessionId ? await Session.findById(req.scope.sessionId) : null) ||
    (req.auth?.sessionId ? await Session.findById(req.auth.sessionId) : null);
  if (!session) {
    const refreshToken = getRefreshTokenFromRequest(req);
    if (refreshToken) {
      const refreshHash = hashToken(refreshToken);
      const nowDate = new Date();
      session = await Session.findOne({
        revokedAt: null,
        expiresAt: { $gt: nowDate },
        $or: [
          { refreshTokenHash: refreshHash },
          {
            previousRefreshTokenHash: refreshHash,
            previousRefreshTokenGraceUntil: { $gt: nowDate },
          },
        ],
      });
    }
  }
  const csrfToken = ensureSessionCsrfToken(session);
  if (csrfToken && session?.isModified?.('csrfToken')) {
    await session.save();
  }
  const headerToken = req.headers['x-csrf-token'];
  return Boolean(csrfToken && headerToken && String(csrfToken) === String(headerToken));
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  authenticateAccessToken,
  buildUserContext,
  buildSessionMetadata,
  clearAuthCookies,
  createSession,
  prepareResponseCsrfToken,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  getRefreshTokenSourceFromRequest,
  revokeSession,
  revokeRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  signAccessToken,
  validateCsrf,
};
