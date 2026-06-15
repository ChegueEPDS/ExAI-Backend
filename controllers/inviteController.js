// controllers/inviteController.js
const Tenant = require('../models/tenant');
const User = require('../models/user');
const TenantJoinInvite = require('../models/tenantJoinInvite');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const mailService = require('../services/mailService');
const { tenantInviteEmailHtml, tenantJoinInviteEmailHtml } = require('../services/mailTemplates');
const { resolvePublicBaseUrl, persistPublicBaseUrlIfMissing } = require('../helpers/publicBaseUrl');
const { assertValidProfessions } = require('../helpers/rbac');
const { migrateAllUserDataToTenant } = require('../services/tenantMigration');

/** Erős ideiglenes jelszó (2-2 kis/nagy/ szám/ spec) */
function generatePassword() {
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const specials = '!@#$%^&*()-_=+[]{};:,.?/';
  const pick = (s) => s[Math.floor(Math.random() * s.length)];

  let pwd = pick(lowers) + pick(lowers) +
            pick(uppers) + pick(uppers) +
            pick(digits) + pick(digits) +
            pick(specials) + pick(specials);
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function inviteExpiryDate() {
  const days = Math.max(1, Math.min(30, Number(process.env.TENANT_JOIN_INVITE_EXPIRY_DAYS || 7)));
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function createOrRefreshJoinInvite({ req, user, fromTenantId, toTenant, invitedBy, targetRole, professions }) {
  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = inviteExpiryDate();
  const toTenantId = toTenant._id;

  await TenantJoinInvite.updateMany(
    {
      userId: user._id,
      toTenantId,
      status: 'pending',
    },
    {
      $set: {
        status: 'expired',
        expiresAt: new Date(),
      }
    }
  );

  const invite = await TenantJoinInvite.create({
    email: user.email,
    userId: user._id,
    fromTenantId,
    toTenantId,
    invitedByUserId: invitedBy._id,
    targetRole: targetRole === 'Admin' ? 'Admin' : 'User',
    ...(Array.isArray(professions) && professions.length ? { professions } : {}),
    tokenHash,
    status: 'pending',
    expiresAt,
  });

  const requestBaseUrl = await resolvePublicBaseUrl({ req, tenantId: toTenantId });
  await persistPublicBaseUrlIfMissing({ tenantId: toTenantId, baseUrl: requestBaseUrl, updatedBy: req.user?.id || req.userId || null });
  const baseUrl = requestBaseUrl || process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
  const joinPath = `/join-invite/${encodeURIComponent(rawToken)}`;
  const acceptUrl = `${baseUrl.replace(/\/+$/, '')}${joinPath}`;
  const rejectUrl = `${baseUrl.replace(/\/+$/, '')}${joinPath}?action=reject`;

  const html = tenantJoinInviteEmailHtml({
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    tenantName: toTenant?.name || 'your organization',
    inviterFirstName: invitedBy.firstName || '',
    inviterLastName: invitedBy.lastName || '',
    inviterEmail: invitedBy.email || '',
    acceptUrl,
    rejectUrl,
    baseUrl,
  });

  await mailService.sendMail({
    to: user.email,
    subject: `You have been invited to join ${toTenant?.name || 'a team'}`,
    html,
    from: process.env.MAIL_SENDER_UPN,
  });

  return invite;
}

/**
 * POST /api/invitations  (LEGYEGYSZERŰSÍTETT FLOW)
 * Body: { tenantId?, email (required), role?('User'|'Admin'), firstName?, lastName?, nickname? }
 *
 * - Admin: csak a saját tenantjába hívhat; SuperAdmin: bármelyikbe.
 * - Ha az e-mail nem létezik:
 *    - seat +1 (atomikus check)
 *    - user létrehozása generált jelszóval és tenantId-vel
 *    - e-mail küldés jelszóval
 * - Ha létező user tenant nélkül:
 *    - seat +1 (atomikus check)
 *    - hozzárendelés a tenantodhoz (role beállítás), név kitöltése ha hiányzott
 *    - e-mail küldés (jelszó nélkül)
 * - Ha már a cél tenant tagja:
 *    - nincs seat módosítás
 *    - e-mail küldés (jelszó nélkül)
 * - Ha másik tenant tagja → 409
 *
 * Front kompatibilitás:
 *  Visszaküld egy "invite" objektumot (legacy mezőkkel null-ra állítva), és ha új user készült,
 *  külön "tempPassword" mezőt is.
 */
exports.createInvite = async (req, res) => {
  const callerRole = (req.role || '').toString();
  const callerTenantId = req.scope?.tenantId || null;

 const {
    tenantId: bodyTenantId,
    email,
    role: targetRole = 'User',
    firstName: bodyFirstName,
    lastName: bodyLastName,
    nickname: bodyNickname,
    professions: bodyProfessions,
  } = req.body || {};

  const tenantId = callerRole === 'SuperAdmin' ? (bodyTenantId || callerTenantId) : callerTenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId hiányzik.' });

  if (callerRole !== 'SuperAdmin' && String(tenantId) !== String(callerTenantId)) {
    return res.status(403).json({ error: 'Csak a saját tenantodra adhatsz hozzá felhasználót.' });
  }

  if (!email) {
    return res.status(400).json({ error: 'email kötelező.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();

  // Név fallback e-mailből, ha nem kaptunk
  const emailLocal = normalizedEmail.split('@')[0];
  let fallbackFirst = '';
  let fallbackLast = '';
  const parts = emailLocal.split('.');
  if (parts.length >= 2) {
    fallbackFirst = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const lastRaw = parts.slice(1).join(' ');
    fallbackLast = lastRaw.charAt(0).toUpperCase() + lastRaw.slice(1);
  } else {
    fallbackFirst = emailLocal.charAt(0).toUpperCase() + emailLocal.slice(1);
    fallbackLast = 'User';
  }
  const firstName = bodyFirstName?.trim() || fallbackFirst || 'User';
  const lastName  = bodyLastName?.trim()  || fallbackLast  || 'User';
  const nickname  = bodyNickname?.trim()  || null;

  // Tenant és seat meta
  const t = await Tenant.findById(tenantId).select('seats plan name type professionRbacEnabled').lean();
  if (!t) return res.status(404).json({ error: 'Tenant nem található.' });

  // If tenant has profession-RBAC enabled, professions become required for create/invite operations.
  let professions = [];
  if (t?.professionRbacEnabled) {
    try {
      professions = assertValidProfessions(bodyProfessions);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Invalid professions' });
    }
    if (!professions.length) {
      return res.status(400).json({ error: 'professions kötelező ennél a tenantnál.' });
    }
  }

  let user = await User.findOne({ email: normalizedEmail });
  let createdNewUser = false;
  let tempPassword = null;

  if (!user) {
    // seat +1 atomikusan
    const seatInc = await Tenant.updateOne(
      { _id: tenantId, 'seats.used': { $lt: t.seats.max } },
      { $inc: { 'seats.used': 1 } }
    );
    if (!seatInc?.acknowledged || seatInc.modifiedCount !== 1) {
      return res.status(400).json({ error: 'Nincs szabad seat a tenantban.' });
    }

    // Új user generált jelszóval
    tempPassword = generatePassword();
    const hash = await bcrypt.hash(String(tempPassword), 10);
    user = await User.create({
      email: normalizedEmail,
      password: hash,
      firstName,
      lastName,
      nickname,
      role: targetRole === 'Admin' ? 'Admin' : 'User',
      tenantId,
      ...(t?.professionRbacEnabled ? { professions } : {}),
      subscriptionTier: t.plan || 'free',
    });
    createdNewUser = true;
  } else {
    const currentTenant = user.tenantId ? String(user.tenantId) : null;

    if (!currentTenant) {
      // seat +1 és hozzárendelés
      const seatInc = await Tenant.updateOne(
        { _id: tenantId, 'seats.used': { $lt: t.seats.max } },
        { $inc: { 'seats.used': 1 } }
      );
      if (!seatInc?.acknowledged || seatInc.modifiedCount !== 1) {
        return res.status(400).json({ error: 'Nincs szabad seat a tenantban.' });
      }
      user.tenantId = tenantId;
      if (user.role !== 'SuperAdmin') {
        user.role = targetRole === 'Admin' ? 'Admin' : 'User';
      }
      if (t?.professionRbacEnabled) {
        user.professions = professions;
      }
      if ((!user.firstName || !user.firstName.trim()) && firstName) user.firstName = firstName;
      if ((!user.lastName  || !user.lastName.trim())  && lastName)  user.lastName  = lastName;
      if ((!user.nickname  || !user.nickname.trim())  && nickname)  user.nickname  = nickname;
      await user.save();
    } else if (currentTenant === String(tenantId)) {
      // már tag → nincs seat módosítás
      if (t?.professionRbacEnabled) {
        user.professions = professions;
        await user.save();
      }
    } else {
      const fromTenant = await Tenant.findById(currentTenant).select('type plan name').lean();
      const canInviteExistingFreePersonal =
        fromTenant?.type === 'personal' &&
        fromTenant?.plan === 'free' &&
        t?.type === 'company' &&
        t?.plan === 'team';

      if (!canInviteExistingFreePersonal) {
        return res.status(409).json({ error: 'A megadott e-mail már másik tenant tagja. Használd az áthelyezés folyamatot.' });
      }

      const invitedBy = await User.findById(req.userId || req.user?.id).select('firstName lastName email').lean();
      if (!invitedBy) return res.status(401).json({ error: 'Inviting user not found.' });

      try {
        await createOrRefreshJoinInvite({
          req,
          user,
          fromTenantId: currentTenant,
          toTenant: t,
          invitedBy,
          targetRole,
          professions,
        });
      } catch (err) {
        console.warn('[mail] tenant join invite failed:', err?.message || err);
        return res.status(500).json({ error: 'Failed to send tenant join invitation.' });
      }

      return res.status(202).json({
        message: 'Tenant join invitation sent.',
        invite: {
          id: null,
          tenantId,
          email: normalizedEmail,
          role: targetRole === 'Admin' ? 'Admin' : 'User',
          status: 'pending_join',
          code: null,
          token: null,
          link: null,
          expiresAt: null,
          maxUses: 1,
        },
        tempPassword: null,
        joinInviteSent: true,
      });
    }
  }

  // --- E-mail (fire-and-forget) ---
  (async () => {
    try {
      const requestBaseUrl = await resolvePublicBaseUrl({ req, tenantId });
      await persistPublicBaseUrlIfMissing({ tenantId, baseUrl: requestBaseUrl, updatedBy: req.user?.id || req.userId || null });
      const loginUrl = requestBaseUrl || process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
      const html = tenantInviteEmailHtml({
        firstName: user.firstName || '',
        lastName:  user.lastName  || '',
        tenantName: t?.name || 'your organization',
        loginUrl,
        baseUrl: requestBaseUrl || undefined,
        password: createdNewUser ? tempPassword : null, // csak új usernél
      });

      await mailService.sendMail({
        to: normalizedEmail,
        subject: createdNewUser
          ? `You have been invited to ${t?.name || 'ATEXdb Certs'}`
          : `You have been added to ${t?.name || 'ATEXdb Certs'}`,
        html,
        from: process.env.MAIL_SENDER_UPN,
      });
      console.log('[mail] invite sent →', normalizedEmail, 'newUser=', createdNewUser);
    } catch (err) {
      console.warn('[mail] invite send failed:', err?.message || err);
    }
  })();

  // Front kompatibilis válasz (legacy invite mezők null-lal)
  return res.status(201).json({
    message: 'User added to tenant.',
    invite: {
      id: null,
      tenantId,
      email: normalizedEmail,
      role: targetRole === 'Admin' ? 'Admin' : 'User',
      code: null,
      token: null,
      link: null,
      expiresAt: null,
      maxUses: 1,
    },
    tempPassword: createdNewUser ? tempPassword : null,
  });
};

exports.getJoinInvite = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing invitation token.' });

    const invite = await TenantJoinInvite.findOne({ tokenHash: hashInviteToken(token) })
      .populate('toTenantId', 'name type plan')
      .populate('fromTenantId', 'name type plan')
      .populate('invitedByUserId', 'firstName lastName email')
      .select('email status expiresAt toTenantId fromTenantId invitedByUserId')
      .lean();
    if (!invite) return res.status(404).json({ error: 'Invitation not found.' });

    const expired = invite.status === 'pending' && new Date(invite.expiresAt).getTime() <= Date.now();
    if (expired) {
      await TenantJoinInvite.updateOne({ _id: invite._id, status: 'pending' }, { $set: { status: 'expired' } });
      invite.status = 'expired';
    }

    return res.json({
      email: invite.email,
      status: invite.status,
      expiresAt: invite.expiresAt,
      toTenant: invite.toTenantId ? {
        id: String(invite.toTenantId._id),
        name: invite.toTenantId.name,
        type: invite.toTenantId.type,
        plan: invite.toTenantId.plan,
      } : null,
      fromTenant: invite.fromTenantId ? {
        id: String(invite.fromTenantId._id),
        name: invite.fromTenantId.name,
        type: invite.fromTenantId.type,
        plan: invite.fromTenantId.plan,
      } : null,
      invitedBy: invite.invitedByUserId ? {
        firstName: invite.invitedByUserId.firstName,
        lastName: invite.invitedByUserId.lastName,
        email: invite.invitedByUserId.email,
      } : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load invitation.' });
  }
};

exports.acceptJoinInvite = async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing invitation token.' });

  try {
    const invite = await TenantJoinInvite.findOneAndUpdate(
      {
        tokenHash: hashInviteToken(token),
        status: 'pending',
        expiresAt: { $gt: new Date() },
      },
      { $set: { status: 'processing' } },
      { new: true }
    );
    if (!invite) return res.status(400).json({ error: 'Invitation is invalid, expired, or already used.' });

    const currentUserId = req.userId || req.user?.id;
    if (String(invite.userId) !== String(currentUserId)) {
      await TenantJoinInvite.updateOne({ _id: invite._id }, { $set: { status: 'pending' } });
      return res.status(403).json({ error: 'This invitation belongs to a different user.' });
    }

    const user = await User.findById(invite.userId);
    if (!user) {
      await TenantJoinInvite.updateOne({ _id: invite._id }, { $set: { status: 'pending' } });
      return res.status(404).json({ error: 'User not found.' });
    }

    const fromTenantId = user.tenantId ? String(user.tenantId) : String(invite.fromTenantId);
    if (String(user.tenantId || '') === String(invite.toTenantId)) {
      await TenantJoinInvite.updateOne(
        { _id: invite._id },
        { $set: { status: 'accepted', acceptedAt: new Date() } }
      );
      return res.json({ message: 'Invitation accepted.', alreadyMember: true });
    }

    if (String(user.tenantId || '') !== String(invite.fromTenantId)) {
      await TenantJoinInvite.updateOne({ _id: invite._id }, { $set: { status: 'pending' } });
      return res.status(409).json({ error: 'Your tenant has changed since this invitation was created.' });
    }

    const toTenant = await Tenant.findById(invite.toTenantId).select('seats name type plan professionRbacEnabled').lean();
    if (!toTenant || toTenant.type !== 'company' || toTenant.plan !== 'team') {
      await TenantJoinInvite.updateOne({ _id: invite._id }, { $set: { status: 'pending' } });
      return res.status(400).json({ error: 'Target team tenant is no longer available.' });
    }

    const seatInc = await Tenant.updateOne(
      { _id: invite.toTenantId, 'seats.used': { $lt: toTenant.seats.max } },
      { $inc: { 'seats.used': 1 } }
    );
    if (!seatInc?.acknowledged || seatInc.modifiedCount !== 1) {
      await TenantJoinInvite.updateOne({ _id: invite._id }, { $set: { status: 'pending' } });
      return res.status(400).json({ error: 'No available seat in the target tenant.' });
    }

    if (fromTenantId) {
      try { await migrateAllUserDataToTenant(fromTenantId, invite.toTenantId); } catch (_) {}
    }

    user.tenantId = invite.toTenantId;
    if (user.role !== 'SuperAdmin') {
      user.role = invite.targetRole === 'Admin' ? 'Admin' : 'User';
    }
    if (toTenant.professionRbacEnabled && Array.isArray(invite.professions) && invite.professions.length) {
      user.professions = invite.professions;
    }
    await user.save();

    if (fromTenantId) {
      await Tenant.updateOne(
        { _id: fromTenantId, 'seats.used': { $gt: 0 } },
        { $inc: { 'seats.used': -1 } }
      );
    }

    await TenantJoinInvite.updateOne(
      { _id: invite._id },
      { $set: { status: 'accepted', acceptedAt: new Date() } }
    );

    return res.json({ message: `You have joined ${toTenant.name}.`, tenantId: String(invite.toTenantId), refreshSession: true });
  } catch (e) {
    try {
      await TenantJoinInvite.updateOne(
        { tokenHash: hashInviteToken(token), status: 'processing' },
        { $set: { status: 'pending' } }
      );
    } catch (_) {}
    return res.status(500).json({ error: e.message || 'Failed to accept invitation.' });
  }
};

exports.rejectJoinInvite = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing invitation token.' });

    const invite = await TenantJoinInvite.findOneAndUpdate(
      {
        tokenHash: hashInviteToken(token),
        status: 'pending',
      },
      { $set: { status: 'rejected', rejectedAt: new Date() } },
      { new: true }
    );
    if (!invite) return res.status(400).json({ error: 'Invitation is invalid or already used.' });
    return res.json({ message: 'Invitation rejected.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to reject invitation.' });
  }
};
