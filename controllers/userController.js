const User = require('../models/user');

// Get User Profile
exports.getUserProfile = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const role = req.role;

    let query;
    if (role === 'SuperAdmin') {
      query = { _id: req.params.userId };
    } else {
      if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });
      query = { _id: req.params.userId, tenantId };
    }

    const user = await User.findOne(query).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update User Profile
exports.updateUserProfile = async (req, res) => {
  const { firstName, lastName, nickname, billingName, billingAddress } = req.body;

  try {
    const tenantId = req.scope?.tenantId;
    const role = req.role;

    let query;
    if (role === 'SuperAdmin') {
      query = { _id: req.params.userId };
    } else {
      if (!tenantId) return res.status(403).json({ error: 'Missing tenantId' });
      query = { _id: req.params.userId, tenantId };
    }

    const user = await User.findOneAndUpdate(
      query,
      { firstName, lastName, nickname, billingName, billingAddress },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};
