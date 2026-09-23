const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AZURE_STORAGE_CONNECTION_STRING ||= 'UseDevelopmentStorage=true';
const { bucketDate, resolveRange, capture, runTasksBounded } = require('../controllers/dashboardSnapshotController')._private;

test('dashboard snapshot buckets rolling time filters for reusable cache keys', () => {
  assert.equal(bucketDate(new Date('2026-09-22T10:04:59.999Z')).toISOString(), '2026-09-22T10:00:00.000Z');
});

test('dashboard snapshot resolves named ranges without rolling cache-key timestamps', () => {
  const now = new Date('2026-09-23T12:34:56.000Z');
  const result = resolveRange('90d', null, null, now);
  assert.equal(result.range, '90d');
  assert.equal(result.from.toISOString(), '2026-06-25T12:34:56.000Z');
  assert.equal(result.to.toISOString(), now.toISOString());
  assert.deepEqual(
    resolveRange('all', null, null, now),
    { range: 'all', from: null, to: null }
  );
});

test('dashboard snapshot captures existing controller JSON results', async () => {
  const value = await capture(async (_req, res) => res.status(200).json({ ok: true }), {});
  assert.deepEqual(value, { ok: true });
});

test('dashboard snapshot rejects failed optional controller responses', async () => {
  await assert.rejects(capture(async (_req, res) => res.status(403).json({ message: 'Forbidden' }), {}), /Forbidden/);
});

test('dashboard snapshot limits concurrent source queries', async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return index;
  });
  const results = await runTasksBounded(tasks, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});
