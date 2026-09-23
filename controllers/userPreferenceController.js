const User = require('../models/user');
const {
  DEFAULT_LOCALE,
  configuredLocales,
  isSupportedLocale,
  normalizeLocale,
} = require('../config/supportedLocales');

function callerUserId(req) {
  return req.user?.id || req.user?._id || req.userId || req.scope?.userId || null;
}

function responseFor(user) {
  return {
    preferredLanguage: normalizeLocale(user?.preferredLanguage) || DEFAULT_LOCALE,
    supportedLocales: configuredLocales(),
  };
}

exports.getMyPreferences = async (req, res) => {
  try {
    const user = await User.findById(callerUserId(req)).select('preferredLanguage').lean();
    if (!user) return res.status(404).json({ error: { code: 'USER_NOT_FOUND' } });
    return res.json(responseFor(user));
  } catch (error) {
    console.error('[user-preferences] load failed:', error);
    return res.status(500).json({ error: { code: 'USER_PREFERENCES_LOAD_FAILED' } });
  }
};

exports.updateMyPreferences = async (req, res) => {
  try {
    const input = req.body || {};
    if (!isSupportedLocale(input.preferredLanguage)) {
      return res.status(400).json({
        error: {
          code: 'UNSUPPORTED_LOCALE',
          params: { supportedLocales: configuredLocales() },
        },
      });
    }
    const preferredLanguage = normalizeLocale(input.preferredLanguage);
    const user = await User.findByIdAndUpdate(
      callerUserId(req),
      { $set: { preferredLanguage } },
      { new: true, runValidators: true }
    ).select('preferredLanguage').lean();
    if (!user) return res.status(404).json({ error: { code: 'USER_NOT_FOUND' } });
    return res.json(responseFor(user));
  } catch (error) {
    console.error('[user-preferences] update failed:', error);
    return res.status(500).json({ error: { code: 'USER_PREFERENCES_UPDATE_FAILED' } });
  }
};

exports.responseFor = responseFor;

