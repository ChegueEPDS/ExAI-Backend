const Manufacturer = require('../models/manufacturer');

function getTenantId(req) {
  return req?.scope?.tenantId ? String(req.scope.tenantId) : null;
}

exports.listManufacturers = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const docs = await Manufacturer.find({ tenantId })
      .select('name')
      .sort({ name: 1 })
      .lean();

    res.json((docs || []).map((d) => d.name));
  } catch (error) {
    console.error('Error fetching manufacturers:', error);
    res.status(500).json({ error: 'Server error while fetching manufacturers.' });
  }
};

// Upsert-like creation for dataplate/exregister flows (requires asset:write on route).
exports.createManufacturer = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const name = String(req?.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing name' });

    const normalizedName = Manufacturer.normalizeName(name);
    if (!normalizedName) return res.status(400).json({ error: 'Invalid name' });

    const existing = await Manufacturer.findOne({ tenantId, normalizedName }).lean();
    if (existing) {
      return res.status(200).json({ ok: true, name: existing.name, created: false });
    }

    const created = await Manufacturer.create({ tenantId, name, normalizedName });
    return res.status(201).json({ ok: true, name: created.name, created: true });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'Manufacturer already exists.' });
    }
    console.error('Error creating manufacturer:', error);
    res.status(500).json({ error: 'Server error while creating manufacturer.' });
  }
};

exports.adminList = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const docs = await Manufacturer.find({ tenantId })
      .select('_id name normalizedName createdAt updatedAt')
      .sort({ name: 1 })
      .lean();
    res.json(docs || []);
  } catch (error) {
    console.error('Error listing manufacturers (admin):', error);
    res.status(500).json({ error: 'Server error while listing manufacturers.' });
  }
};

exports.adminCreate = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const name = String(req?.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing name' });

    const normalizedName = Manufacturer.normalizeName(name);
    if (!normalizedName) return res.status(400).json({ error: 'Invalid name' });

    const existing = await Manufacturer.findOne({ tenantId, normalizedName }).lean();
    if (existing) {
      return res.status(200).json({ ok: true, manufacturer: existing, created: false });
    }

    const created = await Manufacturer.create({ tenantId, name, normalizedName });
    res.status(201).json({ ok: true, manufacturer: created.toObject(), created: true });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'Manufacturer already exists.' });
    }
    console.error('Error creating manufacturer:', error);
    res.status(500).json({ error: 'Server error while creating manufacturer.' });
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const id = String(req?.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const name = String(req?.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing name' });

    const normalizedName = Manufacturer.normalizeName(name);
    if (!normalizedName) return res.status(400).json({ error: 'Invalid name' });

    const updated = await Manufacturer.findOneAndUpdate(
      { _id: id, tenantId },
      { $set: { name, normalizedName } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Manufacturer not found' });
    res.json({ ok: true, manufacturer: updated });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'Manufacturer already exists.' });
    }
    console.error('Error updating manufacturer:', error);
    res.status(500).json({ error: 'Server error while updating manufacturer.' });
  }
};

exports.adminDelete = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });

    const id = String(req?.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const deleted = await Manufacturer.findOneAndDelete({ _id: id, tenantId }).lean();
    if (!deleted) return res.status(404).json({ error: 'Manufacturer not found' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting manufacturer:', error);
    res.status(500).json({ error: 'Server error while deleting manufacturer.' });
  }
};
