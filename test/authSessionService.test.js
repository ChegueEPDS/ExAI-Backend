const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CSRF_COOKIE,
  prepareResponseCsrfToken,
} = require('../services/authSessionService');

test('prepareResponseCsrfToken persists a readable CSRF cookie for web sessions', async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const session = {
    clientType: 'web',
    csrfToken: 'csrf-for-other-tabs',
    expiresAt,
    isModified: () => false,
  };
  const cookies = [];
  const req = { headers: {}, secure: false };
  const res = {
    cookie: (name, value, options) => cookies.push({ name, value, options }),
  };

  const token = await prepareResponseCsrfToken(req, res, { session });

  assert.equal(token, session.csrfToken);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, CSRF_COOKIE);
  assert.equal(cookies[0].value, session.csrfToken);
  assert.equal(cookies[0].options.httpOnly, false);
  assert.equal(cookies[0].options.path, '/');
  assert.ok(cookies[0].options.maxAge > 0);
});
