const test = require('node:test');
const assert = require('node:assert/strict');

test('deleteByIds passes id arrays to Pinecone deleteMany()', async (t) => {
  const savedEnv = { ...process.env };
  process.env.PINECONE_API_KEY = 'test-key';
  process.env.PINECONE_INDEX = 'test-index';
  process.env.PINECONE_DELETE_BATCH = '2';
  delete process.env.PINECONE_HOST;

  const pineconeSdk = require('@pinecone-database/pinecone');

  const originalIndex = pineconeSdk.Pinecone.prototype.index;
  const captured = { namespace: null, calls: [] };

  pineconeSdk.Pinecone.prototype.index = function mockIndex() {
    return {
      namespace(ns) {
        captured.namespace = ns;
        return {
          async deleteMany(arg) {
            captured.calls.push(arg);
          },
        };
      },
    };
  };

  t.after(() => {
    pineconeSdk.Pinecone.prototype.index = originalIndex;
    process.env = savedEnv;
  });

  const modulePath = require.resolve('../services/pineconeService');
  delete require.cache[modulePath];
  const pinecone = require('../services/pineconeService');

  const r = await pinecone.deleteByIds({ namespace: 'ns_1', ids: ['a', 'b', 'c'], bestEffort: false });
  assert.deepEqual(r, { ok: true, deleted: 3 });
  assert.equal(captured.namespace, 'ns_1');
  assert.deepEqual(captured.calls, [['a', 'b'], ['c']]);
});

