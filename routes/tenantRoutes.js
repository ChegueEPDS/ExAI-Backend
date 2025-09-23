// routes/tenantRoutes.js
const express = require('express');
const router = express.Router();

const Tenant = require('../models/tenant');

// Ezek a middleware-ek már vannak a projektben a többi route-nál is:
const { requireAuth, requireRole } = require('../middlewares/authMiddleware');

/**
 * GET /api/tenants/search?q=...
 * Admin / SuperAdmin kereshet meglévő tenantokra (cégnevek)
 */
router.get('/tenants/search', requireAuth, requireRole(['Admin','SuperAdmin']), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }

    const items = await Tenant.find({
      name: { $regex: q, $options: 'i' }
    })
      .select('_id name type plan seats')
      .limit(20)
      .lean();

    return res.json({ items });
  } catch (e) {
    console.error('[tenants/search] error', e);
    return res.status(500).json({ message: 'Search failed.' });
  }
});

/**
 * POST /api/tenants
 * Admin / SuperAdmin tud új tenantot létrehozni.
 * Body:
 *  - name: string (kötelező)
 *  - type: 'company' | 'personal'  (company csak 'team' plan-nel mehet a schema szerint)
 *  - plan: 'free' | 'pro' | 'team'
 *  - seatsMax: number (opcionális; ha team, MIN 5!)
 *  - seatsManaged: 'stripe' | 'manual' (opcionális)
 *  - ownerUserId: (opcionális)
 */
router.post('/tenants', requireAuth, async (req, res) => {
  try {
    let { name, type, plan, seatsMax, seatsManaged = 'stripe', ownerUserId } = req.body || {};

    name = (name || '').toString().trim();
    type = (type || '').toString().trim();
    plan = (plan || '').toString().trim();

    if (!name) {
      return res.status(400).json({ message: 'Tenant name is required.' });
    }
    if (!['company','personal'].includes(type)) {
      return res.status(400).json({ message: 'Invalid tenant type.' });
    }
    if (!['free','pro','team'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan.' });
    }

    // MIN 5 seat szabály team esetén
    if (plan === 'team') {
      const n = Number(seatsMax || 0);
      if (!Number.isInteger(n) || n < 5) {
        return res.status(400).json({ message: 'Team plan requires at least 5 seats.' });
      }
      seatsMax = n;
    } else {
      // personal/free|pro -> max 1 seat értelmezett
      seatsMax = 1;
    }

    // A Tenant séma maga is enforce-olja a company->team és personal->free/pro kapcsolatot
    // (lásd models/tenant.js pre('validate')) – így itt is konzisztens marad. 

    const t = await Tenant.create({
      name,
      type,
      plan,
      ownerUserId: ownerUserId || undefined,
      seats: { max: seatsMax, used: 0 },
      seatsManaged
    });

    return res.status(201).json(t);
  } catch (e) {
    console.error('[tenants/create] error', e);
    return res.status(500).json({ message: e.message || 'Create tenant failed.' });
  }
});

module.exports = router;