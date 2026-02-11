const logger = require('../config/logger');
const tenantSettingsStore = require('../services/tenantSettingsStore');
const { getDefinition } = require('../config/tenantSettingsRegistry');

function extractValuesByKey(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.settings && typeof body.settings === 'object') return body.settings;
  return body;
}

exports.getTenantSettings = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ ok: false, error: 'Missing tenant' });
    const items = await tenantSettingsStore.getAllEffective(String(tenantId));
    return res.json(items);
  } catch (e) {
    logger.error('tenantSettings.get failed', { message: e?.message, stack: e?.stack });
    return res.status(500).json({ ok: false, error: 'Failed to load tenant settings' });
  }
};

exports.updateTenantSettings = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ ok: false, error: 'Missing tenant' });

    const valuesByKey = extractValuesByKey(req.body);
    const keys = Object.keys(valuesByKey || {});

    const unknownKeys = keys.filter((k) => !getDefinition(k));
    if (unknownKeys.length) {
      return res.status(400).json({ ok: false, error: 'Unknown setting key(s)', unknownKeys });
    }

    await tenantSettingsStore.setMany(String(tenantId), valuesByKey, { updatedBy: req.user?.id || req.userId || null });
    const items = await tenantSettingsStore.getAllEffective(String(tenantId));
    return res.json({ ok: true, items });
  } catch (e) {
    logger.error('tenantSettings.update failed', { message: e?.message, stack: e?.stack });
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to update tenant settings' });
  }
};

exports.resetTenantSettingsToDefault = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ ok: false, error: 'Missing tenant' });

    const keys = Array.isArray(req.body?.keys) ? req.body.keys : null;
    await tenantSettingsStore.resetToDefault(String(tenantId), keys, { updatedBy: req.user?.id || req.userId || null });
    const items = await tenantSettingsStore.getAllEffective(String(tenantId));
    return res.json({ ok: true, items });
  } catch (e) {
    logger.error('tenantSettings.reset failed', { message: e?.message, stack: e?.stack });
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to reset tenant settings' });
  }
};

