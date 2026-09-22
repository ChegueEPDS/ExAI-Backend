const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AZURE_STORAGE_CONNECTION_STRING ||= 'UseDevelopmentStorage=true';
const { bucketDate, capture } = require('../controllers/dashboardSnapshotController')._private;

test('dashboard snapshot buckets rolling time filters for reusable cache keys', () => {
  assert.equal(bucketDate(new Date('2026-09-22T10:04:59.999Z')).toISOString(), '2026-09-22T10:00:00.000Z');
});

test('dashboard snapshot captures existing controller JSON results', async () => {
  const value = await capture(async (_req, res) => res.status(200).json({ ok: true }), {});
  assert.deepEqual(value, { ok: true });
});

test('dashboard snapshot rejects failed optional controller responses', async () => {
  await assert.rejects(capture(async (_req, res) => res.status(403).json({ message: 'Forbidden' }), {}), /Forbidden/);
});
