const mongoose = require('mongoose');
const Site = require('../models/site');
const Unit = require('../models/unit');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

exports.getNavigationTree = async (req, res) => {
  try {
    const tenantObjectId = toObjectId(req.scope?.tenantId);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const [sites, units] = await Promise.all([
      Site.find({ tenantId: tenantObjectId })
        .select('_id Name Client updatedAt')
        .sort({ Name: 1, _id: 1 })
        .lean(),
      Unit.find({ tenantId: tenantObjectId })
        .select('_id Name Site parentUnitId ancestors depth updatedAt')
        .sort({ Site: 1, depth: 1, Name: 1, _id: 1 })
        .lean()
    ]);

    return res.json({ sites, units });
  } catch (error) {
    console.error('getNavigationTree error:', error);
    return res.status(500).json({ message: 'Failed to fetch navigation tree.' });
  }
};
