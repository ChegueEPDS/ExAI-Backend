const User = require('../models/user');

// Get User Profile
exports.getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password'); // Exclude password
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
    const user = await User.findByIdAndUpdate(
      req.params.userId,
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
