const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePermissions,
  hasAnyPermission,
  getEffectiveProfessions,
} = require('../helpers/rbac');

test('effective professions default to manager for legacy users', () => {
  assert.deepEqual(getEffectiveProfessions({ role: 'User', professions: undefined }), ['manager']);
  assert.deepEqual(getEffectiveProfessions({ role: 'User', professions: [] }), ['manager']);
});

test('Admin and SuperAdmin are treated as manager', () => {
  assert.deepEqual(getEffectiveProfessions({ role: 'Admin', professions: ['operative'] }), ['manager']);
  assert.deepEqual(getEffectiveProfessions({ role: 'SuperAdmin', professions: [] }), ['manager']);
});

test('operative permissions: can report fault, cannot write asset', () => {
  const perms = computePermissions({ role: 'User', professions: ['operative'] });
  assert.equal(hasAnyPermission(perms, 'maintenance:fault:report'), true);
  assert.equal(hasAnyPermission(perms, 'maintenance:manage'), false);
  assert.equal(hasAnyPermission(perms, 'asset:write'), false);
});

test('ex_inspector permissions: inspection manage, maintenance fault only', () => {
  const perms = computePermissions({ role: 'User', professions: ['ex_inspector'] });
  assert.equal(hasAnyPermission(perms, 'inspection:manage'), true);
  assert.equal(hasAnyPermission(perms, 'site:write'), true);
  assert.equal(hasAnyPermission(perms, 'maintenance:fault:report'), true);
  assert.equal(hasAnyPermission(perms, 'maintenance:manage'), false);
});

test('technician permissions: maintenance manage, no inspection manage', () => {
  const perms = computePermissions({ role: 'User', professions: ['technician'] });
  assert.equal(hasAnyPermission(perms, 'maintenance:manage'), true);
  assert.equal(hasAnyPermission(perms, 'inspection:manage'), false);
  assert.equal(hasAnyPermission(perms, 'inspection:read'), true);
});

test('multiple professions: unions permissions', () => {
  const perms = computePermissions({ role: 'User', professions: ['technician', 'ex_inspector'] });
  assert.equal(hasAnyPermission(perms, 'maintenance:manage'), true);
  assert.equal(hasAnyPermission(perms, 'inspection:manage'), true);
});

test('manager wildcard implies everything', () => {
  const perms = computePermissions({ role: 'User', professions: ['manager'] });
  assert.equal(hasAnyPermission(perms, 'asset:write'), true);
  assert.equal(hasAnyPermission(perms, 'inspection:manage'), true);
  assert.equal(hasAnyPermission(perms, 'maintenance:manage'), true);
});

