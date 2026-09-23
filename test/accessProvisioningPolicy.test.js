const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('self-service registration is explicitly disabled', () => {
  const source = fs.readFileSync(path.join(root, 'routes/authRoutes.js'), 'utf8');
  assert.match(source, /router\.post\('\/register'.*status\(403\)/s);
  assert.match(source, /Self-service registration is disabled/);
});

test('user provisioning is restricted to Admin and SuperAdmin', () => {
  const source = fs.readFileSync(path.join(root, 'routes/inviteRoutes.js'), 'utf8');
  assert.match(
    source,
    /router\.post\('\/invitations', authMiddleware\(\['Admin', 'SuperAdmin'\]\), createInvite\)/
  );
});

test('only SuperAdmin can create tenants and user provisioning has no seat limit', () => {
  const tenantRoutes = fs.readFileSync(path.join(root, 'routes/tenantRoutes.js'), 'utf8');
  const inviteController = fs.readFileSync(path.join(root, 'controllers/inviteController.js'), 'utf8');
  assert.match(
    tenantRoutes,
    /router\.post\(\s*'\/tenants',\s*authMiddleware\(\['SuperAdmin'\]\),\s*createTenant/s
  );
  assert.doesNotMatch(inviteController, /seats\.used[^\n]*\$lt|Nincs szabad seat|No available seat/);
});

test('Stripe is not an installed dependency or mounted API', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.equal(pkg.dependencies?.stripe, undefined);
  assert.doesNotMatch(appSource, /billingWebhook|\/api\/billing|upgradeRoutes/);
});
