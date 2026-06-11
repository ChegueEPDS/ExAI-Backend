const crypto = require('crypto');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const mailService = require('./mailService');
const { tenantInviteEmailHtml } = require('./mailTemplates');
const { withLock } = require('./distributedLockService');
const logger = require('../config/logger');

const DEFAULT_EMAIL = 'kovacs@epds.hu';

function shouldSeedSuperAdmin() {
  if (process.env.NODE_ENV === 'test') return false;
  return String(process.env.SEED_SUPERADMIN_ON_EMPTY_DB || 'true').toLowerCase() !== 'false';
}

function generateInitialPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function getLoginUrl() {
  const base = String(
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL_CERTS ||
    process.env.FRONTEND_PUBLIC_URL ||
    ''
  ).replace(/\/+$/, '');
  return base ? `${base}/login` : '/login';
}

async function createAndNotifySuperAdmin() {
  const existingUsers = await User.estimatedDocumentCount();
  if (existingUsers > 0) return { seeded: false, reason: 'users_exist' };

  const email = String(process.env.SEED_SUPERADMIN_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  const password = generateInitialPassword();
  let tenant = null;
  let user = null;

  try {
    tenant = await Tenant.create({
      name: 'epds',
      type: 'company',
      plan: 'team',
      seats: { max: 5, used: 1 },
      seatsManaged: 'manual',
      professionRbacEnabled: true
    });

    user = await User.create({
      firstName: 'Kovacs',
      lastName: 'EPDS',
      email,
      password,
      role: 'SuperAdmin',
      professions: ['manager'],
      tenantId: tenant._id,
      emailVerified: true
    });

    tenant.ownerUserId = user._id;
    await tenant.save();

    await mailService.sendMail({
      to: email,
      subject: 'Initial SuperAdmin account',
      html: tenantInviteEmailHtml({
        firstName: user.firstName,
        lastName: user.lastName,
        tenantName: tenant.name,
        loginUrl: getLoginUrl(),
        password,
        baseUrl: process.env.APP_PUBLIC_BASE_URL || process.env.APP_BASE_URL_CERTS || ''
      })
    });

    logger.info('[bootstrap] Seeded initial SuperAdmin account', {
      email,
      tenantId: String(tenant._id),
      userId: String(user._id)
    });
    return { seeded: true, email };
  } catch (err) {
    if (user?._id) await User.deleteOne({ _id: user._id }).catch(() => {});
    if (tenant?._id) await Tenant.deleteOne({ _id: tenant._id }).catch(() => {});
    logger.error('[bootstrap] Initial SuperAdmin seed failed; rolled back seed records', {
      email,
      error: err?.message || String(err)
    });
    return { seeded: false, reason: 'failed', error: err };
  }
}

async function seedInitialSuperAdminIfEmpty() {
  if (!shouldSeedSuperAdmin()) return { seeded: false, reason: 'disabled' };
  return withLock('bootstrap:initial-superadmin', 60_000, createAndNotifySuperAdmin);
}

module.exports = {
  seedInitialSuperAdminIfEmpty
};
