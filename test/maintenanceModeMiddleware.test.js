const assert = require('node:assert/strict');
const test = require('node:test');

const systemSettings = require('../services/systemSettingsStore');
const {
  getMaintenanceStatus,
  maintenanceModeMiddleware,
  normalizeMode,
} = require('../middlewares/maintenanceModeMiddleware');

function runMiddleware({ method = 'GET', path = '/api/example' } = {}) {
  const response = { headers: {}, statusCode: 200, body: null };
  const req = { method, path, requestId: 'req-1' };
  const res = {
    setHeader(name, value) { response.headers[name] = value; },
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return this; },
  };
  let nextCalled = false;
  maintenanceModeMiddleware(req, res, () => { nextCalled = true; });
  return { ...response, nextCalled };
}

test.afterEach(() => systemSettings._resetInMemoryForTests());

test('normalizes unsupported modes to off', () => {
  assert.equal(normalizeMode('read_only'), 'read_only');
  assert.equal(normalizeMode('unexpected'), 'off');
});

test('display mode exposes status without blocking writes', () => {
  systemSettings._setInMemoryForTests({ MAINTENANCE_MODE: 'display' });
  assert.equal(getMaintenanceStatus().active, true);
  assert.equal(runMiddleware({ method: 'POST' }).nextCalled, true);
});

test('read-only mode blocks state-changing API requests', () => {
  systemSettings._setInMemoryForTests({
    MAINTENANCE_MODE: 'read_only',
    MAINTENANCE_MESSAGE: 'Back soon',
  });
  const result = runMiddleware({ method: 'PATCH' });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, 'MAINTENANCE_MODE');
  assert.equal(result.body.message, 'Back soon');
  assert.equal(result.headers['Retry-After'], '300');
});

test('read-only mode keeps reads and the SuperAdmin control endpoint available', () => {
  systemSettings._setInMemoryForTests({ MAINTENANCE_MODE: 'read_only' });
  assert.equal(runMiddleware({ method: 'GET' }).nextCalled, true);
  assert.equal(runMiddleware({ method: 'PUT', path: '/api/admin/system-settings' }).nextCalled, true);
  assert.equal(runMiddleware({ method: 'POST', path: '/api/login' }).nextCalled, true);
  assert.equal(runMiddleware({ method: 'POST', path: '/api/auth/refresh' }).nextCalled, true);
});
