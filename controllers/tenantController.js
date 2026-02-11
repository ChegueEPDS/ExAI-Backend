// controllers/tenantController.js
const Tenant = require('../models/tenant');

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64);
}

async function ensureUniqueTenantName(base) {
  const raw = base && base.trim() ? base : `tenant-${Math.random().toString(36).slice(2,8)}`;
  let candidate = slugify(raw);
  let i = 1;
  while (await Tenant.findOne({ name: candidate })) {
    i += 1;
    candidate = slugify(`${raw}-${i}`);
  }
  return candidate;
}
/**
 * GET /api/tenants
 * - Admin: csak a saját tenantját látja
 * - SuperAdmin: az összes tenantot
 */
exports.listTenants = async (req, res) => {
  try {
    const role = String(req.role || '');
    const tenantId = req.scope?.tenantId || null;

    let query = {};
    if (role !== 'SuperAdmin') {
      if (!tenantId) {
        return res.status(403).json({ message: 'Missing tenantId' });
      }
      query._id = tenantId;
    }

    const tenants = await Tenant.find(query)
      .select('_id name type plan seats seatsManaged ownerUserId professionRbacEnabled createdAt updatedAt')
      .lean();

    return res.json({ items: tenants, total: tenants.length });
  } catch (e) {
    console.error('[tenants/list] error', e);
    return res.status(500).json({ message: 'List tenants failed.' });
  }
};

/**
 * GET /api/tenants/search?q=...
 * Admin / SuperAdmin kereshet tenantokat (név részlet alapján)
 */
exports.searchTenants = async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }

    const items = await Tenant.find({
      name: { $regex: q, $options: 'i' }
    })
      .select('_id name type plan seats professionRbacEnabled')
      .limit(20)
      .lean();

    return res.json({ items });
  } catch (e) {
    console.error('[tenants/search] error', e);
    return res.status(500).json({ message: 'Search failed.' });
  }
};

/**
 * POST /api/tenants
 * Admin / SuperAdmin tud új tenantot létrehozni
 * Body:
 *  - name?: string (ha nincs, slug/unique generálás)
 *  - type: 'company' | 'personal'  (schema: company -> csak 'team')
 *  - plan: 'free' | 'pro' | 'team'
 *  - seatsMax?: number (team: MIN 5; personal: 1)
 *  - seatsManaged?: 'stripe' | 'manual' (default: 'stripe')
 *  - ownerUserId?: ObjectId (opcionális; csak tároljuk, used itt 0 marad)
 */
exports.createTenant = async (req, res) => {
  try {
    let { name, type, plan, seatsMax, seatsManaged = 'stripe', ownerUserId } = req.body || {};

    type = String(type || '').trim();
    plan = String(plan || '').trim();

    if (!['company','personal'].includes(type)) {
      return res.status(400).json({ message: 'Invalid tenant type.' });
    }
    if (!['free','pro','team'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan.' });
    }
    // Üzleti szabályok a schema-val összhangban
    if (type === 'company' && plan !== 'team') {
      return res.status(400).json({ message: 'Company tenant must use team plan.' });
    }
    if (type === 'personal' && !['free','pro'].includes(plan)) {
      return res.status(400).json({ message: 'Personal tenant must be free or pro.' });
    }

    // seats: team >=5, különben 1
    if (plan === 'team') {
      const n = Number(seatsMax || 0);
      if (!Number.isInteger(n) || n < 5) {
        return res.status(400).json({ message: 'Team plan requires at least 5 seats.' });
      }
      seatsMax = n;
    } else {
      seatsMax = 1;
    }

    // név: ha nincs megadva, generálunk egyedi slugot
    const finalName = await ensureUniqueTenantName(name || (type === 'personal' ? 'u-personal' : 'company'));

    const t = await Tenant.create({
      name: finalName,
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
};

/**
 * GET /api/tenants/:id
 * - Admin → csak a saját tenantját láthatja
 * - SuperAdmin → bármelyiket
 */
exports.getTenantById = async (req, res) => {
  try {
    const { id } = req.params;
    const role = String(req.role || '');
    const tenantId = req.scope?.tenantId || null;

    if (role !== 'SuperAdmin' && String(tenantId) !== String(id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const tenant = await Tenant.findById(id)
      .select('_id name type plan seats seatsManaged ownerUserId professionRbacEnabled createdAt updatedAt')
      .lean();

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    return res.json(tenant);
  } catch (e) {
    console.error('[tenants/getById] error', e);
    return res.status(500).json({ message: 'Get tenant failed.' });
  }
};

/**
 * PATCH /api/tenants/:id
 * - Admin → csak a saját tenantját módosíthatja
 * - SuperAdmin → bármelyiket
 * Body: { name?, seatsMax?, seatsManaged?, plan? }
 * Megjegyzés: type NEM módosítható ezen az endpointon.
 */
exports.updateTenant = async (req, res) => {
  try {
    const { id } = req.params;
    const role = String(req.role || '');
    const callerTenantId = req.scope?.tenantId || null;

    if (role !== 'SuperAdmin' && String(callerTenantId) !== String(id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const tenant = await Tenant.findById(id);
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    const { name, seatsMax, seatsManaged, plan, professionRbacEnabled } = req.body || {};
    const updates = {};

    // name (slug + ensure unique)
    if (typeof name === 'string' && name.trim()) {
      const uniqueName = await ensureUniqueTenantName(name);
      updates.name = uniqueName;
    }

    // seatsManaged
    if (typeof seatsManaged === 'string') {
      if (!['stripe', 'manual'].includes(seatsManaged)) {
        return res.status(400).json({ message: 'Invalid seatsManaged (stripe|manual).' });
      }
      updates.seatsManaged = seatsManaged;
    }

    // plan – csak a schema szerinti kombináció engedélyezett, type nem változik itt
    if (typeof plan === 'string' && plan.trim()) {
      if (!['free', 'pro', 'team'].includes(plan)) {
        return res.status(400).json({ message: 'Invalid plan.' });
      }
      if (tenant.type === 'company' && plan !== 'team') {
        return res.status(400).json({ message: 'Company tenant must use team plan.' });
      }
      if (tenant.type === 'personal' && !['free', 'pro'].includes(plan)) {
        return res.status(400).json({ message: 'Personal tenant must be free or pro.' });
      }
      updates.plan = plan;
    }

    // seats.max – nem mehet a jelenlegi used alá
    if (seatsMax !== undefined) {
      const n = Number(seatsMax);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ message: 'Invalid seatsMax' });
      }
      const used = (tenant.seats && typeof tenant.seats.used === 'number') ? tenant.seats.used : 0;

      if (n < used) {
        return res.status(400).json({ message: `seatsMax (${n}) cannot be less than current used (${used}).` });
      }

      // team esetén minimum 5 (üzleti szabály)
      if (tenant.plan === 'team' || updates.plan === 'team') {
        if (n < 5) {
          return res.status(400).json({ message: 'Team plan requires at least 5 seats.' });
        }
      } else {
        // personal/pro/free esetén mindig 1 – ha mégis nagyobbra állítanák, normáljuk 1-re
        if (n !== 1) {
          return res.status(400).json({ message: 'Personal/pro plans must have seatsMax = 1.' });
        }
      }

      updates['seats.max'] = n;
    }

    // profession RBAC feature flag (SuperAdmin only)
    if (professionRbacEnabled !== undefined) {
      if (role !== 'SuperAdmin') {
        return res.status(403).json({ message: 'Only SuperAdmin can change profession RBAC settings.' });
      }
      updates.professionRbacEnabled = Boolean(professionRbacEnabled);
    }

    // Végrehajtás
    const updated = await Tenant.findByIdAndUpdate(id, updates, { new: true });
    return res.json(updated);
  } catch (e) {
    console.error('[tenants/update] error', e);
    return res.status(500).json({ message: 'Update tenant failed.' });
  }
};

/**
 * DELETE /api/tenants/:id
 * - Admin → csak a saját tenantját törölheti
 * - SuperAdmin → bármelyiket
 * FIGYELEM: ez a végpont nem kezeli az adott tenanthoz tartozó felhasználók/adatok törlését.
 * Élesben ide érdemes egy biztonsági ellenőrzést tenni (pl. csak üres tenant törölhető),
 * vagy migráció/archive folyamatot futtatni.
 */
exports.deleteTenant = async (req, res) => {
  try {
    const { id } = req.params;
    const role = String(req.role || '');
    const callerTenantId = req.scope?.tenantId || null;

    if (role !== 'SuperAdmin' && String(callerTenantId) !== String(id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const result = await Tenant.findByIdAndDelete(id);
    if (!result) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    return res.json({ message: 'Tenant deleted.' });
  } catch (e) {
    console.error('[tenants/delete] error', e);
    return res.status(500).json({ message: 'Delete tenant failed.' });
  }
};
