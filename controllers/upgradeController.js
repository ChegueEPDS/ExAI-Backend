// controllers/upgradeController.js
const Tenant = require('../models/tenant');
const User = require('../models/user');
const { migrateAllUserDataToTenant } = require('../services/tenantMigration');
// opcionálisan ide is hozható a checkout készítés

// POST /api/upgrade-to-team
// body: { companyName, successUrl, cancelUrl, priceId }
exports.upgradeToTeam = async (req, res) => {
  try {
    const userId = req.scope?.userId || req.user?.id;
    const { companyName } = req.body;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user?.tenantId) return res.status(400).json({ message: 'No personal tenant' });

    // Új company tenant
    const name = String(companyName || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ message: 'Company name required' });

    const teamTenant = await Tenant.create({
      name,
      type: 'company',
      plan: 'team',                // a fizetés után is team marad
      ownerUserId: user._id,
      seats: { max: 5, used: 1 }
    });

    // Adat-migráció: a user eddigi personal tenantjának adatai → új céghez
    await migrateAllUserDataToTenant(user.tenantId, teamTenant._id);

    // User átállítás az új company tenant-ra + role
    user.tenantId = teamTenant._id;
    user.subscriptionTier = 'team';
    user.role = 'Admin';
    await user.save();

    // Itt visszaadhatod a Checkout URL-t is, ha itt hozod létre.
    res.json({
      message: '✅ Team tenant created & data migrated. Proceed to Stripe checkout.',
      tenantId: teamTenant._id
    });
  } catch (e) {
    console.error('[upgrade] to team error', e);
    res.status(500).json({ message: e.message });
  }
};