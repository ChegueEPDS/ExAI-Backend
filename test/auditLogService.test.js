const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/auditLog');
const { inferAction, shouldAuditRequest, writeAuditLog } = require('../services/auditLogService');

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
