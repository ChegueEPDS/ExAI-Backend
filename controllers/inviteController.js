// controllers/inviteController.js
const mongoose = require('mongoose');
const Invite = require('../models/invite');
const Tenant = require('../models/tenant');
const User = require('../models/user');
const { migrateAllUserDataToTenant } = require('../services/tenantMigration');

/**
 * POST /api/invitations
 * Body: { tenantId?, email?, role?, expiresInHours?, maxUses? }
 * Admin: csak a saját tenantjához hozhat létre. SuperAdmin bármelyikhez.
 * Visszaad: { code, token, link }
 */
exports.createInvite = async (req, res) => {
  const role = (req.role || '').toString();
  const callerTenantId = req.scope?.tenantId || null;

  const {
    tenantId: bodyTenantId,
    email,
    role: targetRole = 'User',
    expiresInHours = 168, // 7 nap
    maxUses = 1
  } = req.body || {};

  const tenantId = role === 'SuperAdmin' ? (bodyTenantId || callerTenantId) : callerTenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId hiányzik.' });

  // Admin csak a saját tenantjára készíthet meghívót
  if (role !== 'SuperAdmin' && String(tenantId) !== String(callerTenantId)) {
    return res.status(403).json({ error: 'Csak a saját tenantodra hozhatsz létre meghívót.' });
  }

  // Minimális seat-ellenőrzés: legyen legalább 1 szabad (nem fogyaszt ekkor, csak check)
  const t = await Tenant.findById(tenantId).select('seats').lean();
  if (!t) return res.status(404).json({ error: 'Tenant nem található.' });
  if ((t.seats?.max || 0) <= (t.seats?.used || 0)) {
    return res.status(400).json({ error: 'Nincs szabad seat – nem hozható létre meghívó.' });
  }

  const code = Invite.generateCode();
  const token = Invite.generateToken();
  const expiresAt = new Date(Date.now() + Number(expiresInHours) * 3600 * 1000);

  const invite = await Invite.create({
    tenantId,
    email: email ? String(email).trim().toLowerCase() : undefined,
    role: targetRole === 'Admin' ? 'Admin' : 'User', // ne engedjük feljebb
    code,
    token,
    expiresAt,
    maxUses: Math.max(1, Number(maxUses) || 1),
    createdBy: req.scope?.userId || null
  });

  const link = `${process.env.APP_BASE_URL || 'https://app.example.com'}/accept-invite?token=${token}`;

  return res.status(201).json({
    message: 'Invite created.',
    invite: {
      id: invite._id,
      tenantId,
      email: invite.email || null,
      role: invite.role,
      code,
      token,
      link,
      expiresAt,
      maxUses: invite.maxUses
    }
  });
};

/**
 * POST /api/invitations/accept
 * Body: { token? , code? }
 * Auth szükséges: a meghívást **a belépett user** fogadja el.
 * Lépések (tranzakció):
 *  - Meghívó ellenőrzése (usable)
 *  - Seat foglalás (used +1, ha van hely)
 *  - (Ha user már ebben a tenantban van → idempotens: csak used nem nő)
 *  - Ha más tenantban volt → migráció + from.used--
 *  - user.role csak akkor frissül Adminra, ha invite.role='Admin' és a caller nem SuperAdmin (SuperAdmin marad)
 *  - usedCount++
 */
/**
 * POST /api/invitations/accept
 * Body: { token? , code? }
 * Auth szükséges: a meghívást **a belépett user** fogadja el.
 * Non-transactional verzió, standalone MongoDB-hez.
 */
exports.acceptInvite = async (req, res) => {
  const userId = req.scope?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Bejelentkezés szükséges a meghívás elfogadásához.' });

  const { token, code } = req.body || {};
  if (!token && !code) return res.status(400).json({ error: 'Adj meg token-t vagy kódot.' });

  try {
    const invite = await Invite.findOne(token ? { token } : { code });
    if (!invite) return res.status(404).json({ error: 'Meghívó nem található.' });

    // Usability check
    if (!invite.isUsable()) return res.status(400).json({ error: 'Meghívó lejárt, felhasznált vagy visszavonva.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User nem található.' });

    const toTenantId = String(invite.tenantId);
    const fromTenantId = user.tenantId ? String(user.tenantId) : null;

    // Ha már bent van → idempotens: csak meghívó számláló
    if (String(user.tenantId) === toTenantId) {
      invite.usedCount += 1;
      if (invite.usedCount >= invite.maxUses) invite.status = 'expired';
      await invite.save();
      return res.json({ message: 'Már tagja vagy a tenantnak. Meghívó elfogadva (idempotens).' });
    }

    // Seat foglalás a cél tenantban – atomikus feltétellel
    const toTenant = await Tenant.findById(toTenantId).select('seats').lean();
    if (!toTenant) return res.status(404).json({ error: 'Cél tenant nem található.' });

    const seatInc = await Tenant.updateOne(
      { _id: toTenantId, 'seats.used': { $lt: toTenant.seats.max } },
      { $inc: { 'seats.used': 1 } }
    );
    if (!seatInc?.acknowledged || seatInc.modifiedCount !== 1) {
      return res.status(400).json({ error: 'Nincs szabad seat a cél tenantban.' });
    }

    // Migráció (ha volt forrás tenant)
    if (fromTenantId) {
      try { await migrateAllUserDataToTenant(fromTenantId, toTenantId); } catch (_) {}
    }

    // User átpakolása + szerepkör (SuperAdmin-t nem írjuk felül)
    user.tenantId = toTenantId;
    if (user.role !== 'SuperAdmin' && invite.role === 'Admin') {
      user.role = 'Admin';
    }
    await user.save();

    // Forrás tenant felszabadítás
    if (fromTenantId) {
      await Tenant.updateOne(
        { _id: fromTenantId, 'seats.used': { $gt: 0 } },
        { $inc: { 'seats.used': -1 } }
      );
    }

    // Meghívó fogyasztása
    invite.usedCount += 1;
    if (invite.usedCount >= invite.maxUses) invite.status = 'expired';
    await invite.save();

    return res.json({ message: '✅ Meghívás elfogadva, csatlakoztál a tenanthoz.' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};

/**
 * GET /api/invitations/open?token=...
 * - Frontend validációhoz: visszaadja a meghívó metaadatait (tenant neve, role, lejárat).
 */
exports.openInvite = async (req, res) => {
  const { token } = req.query || {};
  if (!token) return res.status(400).json({ error: 'Hiányzó token.' });

  const invite = await Invite.findOne({ token }).populate('tenantId', 'name type plan seats').lean();
  if (!invite) return res.status(404).json({ error: 'Meghívó nem található.' });

  const usable = (new Invite(invite)).isUsable(); // gyors ellenőrzés
  return res.json({
    usable,
    invite: {
      tenantName: invite.tenantId?.name || null,
      tenantType: invite.tenantId?.type || null,
      plan: invite.tenantId?.plan || null,
      role: invite.role,
      expiresAt: invite.expiresAt,
      usedCount: invite.usedCount,
      maxUses: invite.maxUses,
      status: invite.status
    }
  });
};

/**
 * POST /api/invitations/revoke
 * Body: { id? , token? , code? }
 * - Meghívó visszavonása (Admin/SuperAdmin)
 */
exports.revokeInvite = async (req, res) => {
  const role = (req.role || '').toString();
  const callerTenantId = req.scope?.tenantId || null;
  const { id, token, code } = req.body || {};

  const q = id ? { _id: id } : token ? { token } : code ? { code } : null;
  if (!q) return res.status(400).json({ error: 'Adj meg id/token/code értéket.' });

  const invite = await Invite.findOne(q);
  if (!invite) return res.status(404).json({ error: 'Meghívó nem található.' });

  // Admin csak saját tenant meghívóját vonhatja vissza
  if (role !== 'SuperAdmin' && String(invite.tenantId) !== String(callerTenantId)) {
    return res.status(403).json({ error: 'Nincs jogosultság a meghívó visszavonásához.' });
  }

  invite.status = 'revoked';
  await invite.save();
  return res.json({ message: 'Meghívó visszavonva.' });
};