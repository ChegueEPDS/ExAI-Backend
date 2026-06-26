const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/auditLog');
const {
  inferAction,
  serializeError,
  shouldAuditRequest,
  shouldAuditResponse,
  writeAuditLog
} = require('../services/auditLogService');

function req(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/users',
    headers: {},
    params: {},
    ...overrides,
  };
}

test('should audit write requests', () => {
  assert.equal(shouldAuditRequest(req({ method: 'PATCH', originalUrl: '/api/user/abc' })), true);
  assert.equal(shouldAuditRequest(req({ method: 'DELETE', originalUrl: '/api/user/abc' })), true);
});

test('should audit auth endpoints but not the audit table itself', () => {
  assert.equal(shouldAuditRequest(req({ method: 'POST', originalUrl: '/api/login' })), true);
  assert.equal(shouldAuditRequest(req({ method: 'POST', originalUrl: '/api/logout' })), true);
  assert.equal(shouldAuditRequest(req({ method: 'GET', originalUrl: '/api/admin/audit-logs' })), false);
});

test('audits API 5xx responses even for read requests', () => {
  assert.equal(shouldAuditResponse(req({ method: 'GET', originalUrl: '/api/users' }), 500), true);
  assert.equal(shouldAuditResponse(req({ method: 'GET', originalUrl: '/api/users' }), 200), false);
  assert.equal(shouldAuditResponse(req({ method: 'GET', originalUrl: '/api/admin/audit-logs' }), 500), false);
});

test('infers stable action names from auth paths and resources', () => {
  assert.equal(inferAction(req({ method: 'POST', originalUrl: '/api/login' })), 'auth.login');
  assert.equal(inferAction(req({ method: 'POST', originalUrl: '/api/renew-token' })), 'auth.renewToken');
  assert.equal(inferAction(req({ method: 'PATCH', originalUrl: '/api/users/123/professions' })), 'users.update');
  assert.equal(inferAction(req({ method: 'DELETE', originalUrl: '/api/user/123' })), 'user.delete');
});

test('skips noisy failed renew-token audit rows', async () => {
  const originalCreate = AuditLog.create;
  let called = false;
  AuditLog.create = async () => {
    called = true;
  };

  try {
    await writeAuditLog(
      req({ method: 'POST', originalUrl: '/api/renew-token' }),
      { statusCode: 401 }
    );
    assert.equal(called, false);
  } finally {
    AuditLog.create = originalCreate;
  }
});

test('serializes error details for diagnostics', () => {
  const details = serializeError(Object.assign(new Error('database exploded'), { code: 'E_DB' }));
  assert.equal(details.errorName, 'Error');
  assert.equal(details.errorMessage, 'database exploded');
  assert.equal(details.errorCode, 'E_DB');
  assert.match(details.stack, /database exploded/);
});
