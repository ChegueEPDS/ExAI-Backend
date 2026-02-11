// controllers/inviteController.js
const Tenant = require('../models/tenant');
const User = require('../models/user');
const bcrypt = require('bcrypt');
const mailService = require('../services/mailService');
const { tenantInviteEmailHtml } = require('../services/mailTemplates');
const { assertValidProfessions } = require('../helpers/rbac');

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
  const t = await Tenant.findById(tenantId).select('seats plan name professionRbacEnabled').lean();
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
      // másik tenant tagja → explicit flow
      return res.status(409).json({ error: 'A megadott e-mail már másik tenant tagja. Használd az áthelyezés folyamatot.' });
    }
  }

  // --- E-mail (fire-and-forget) ---
  (async () => {
    try {
      const loginUrl = process.env.APP_BASE_URL_CERTS || 'https://certs.atexdb.eu';
      const html = tenantInviteEmailHtml({
        firstName: user.firstName || '',
        lastName:  user.lastName  || '',
        tenantName: t?.name || 'your organization',
        loginUrl,
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
