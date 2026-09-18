const systemSettings = require('../services/systemSettingsStore');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CONTROL_PATHS = new Set([
  '/api/admin/system-settings',
  '/api/admin/system-settings/reset',
]);
const AUTH_RECOVERY_PATHS = new Set([
  '/api/login',
  '/api/microsoft-login',
  '/api/renew-token',
  '/api/auth/refresh',
  '/api/logout',
]);

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['display', 'read_only'].includes(mode) ? mode : 'off';
}

function getMaintenanceStatus() {
  const mode = normalizeMode(systemSettings.getString('MAINTENANCE_MODE'));
  return {
    active: mode !== 'off',
    mode,
    writeApiBlocked: mode === 'read_only',
    message: systemSettings.getString('MAINTENANCE_MESSAGE'),
    expectedBack: systemSettings.getString('MAINTENANCE_EXPECTED_BACK'),
  };
}

function maintenanceModeMiddleware(req, res, next) {
  const status = getMaintenanceStatus();
  if (
    !status.writeApiBlocked ||
    SAFE_METHODS.has(req.method) ||
    CONTROL_PATHS.has(req.path) ||
    AUTH_RECOVERY_PATHS.has(req.path)
  ) {
    return next();
  }

  res.setHeader('Retry-After', '300');
  return res.status(503).json({
    ok: false,
    error: 'MAINTENANCE_MODE',
    message: status.message,
    expectedBack: status.expectedBack || null,
    requestId: req.requestId || null,
  });
}

module.exports = {
  getMaintenanceStatus,
  maintenanceModeMiddleware,
  normalizeMode,
};
