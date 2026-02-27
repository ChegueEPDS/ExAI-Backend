const test = require('node:test');
const assert = require('node:assert/strict');

test('deleteByFilter passes filter directly to Pinecone deleteMany()', async (t) => {
  const savedEnv = { ...process.env };
  process.env.PINECONE_API_KEY = 'test-key';
  process.env.PINECONE_INDEX = 'test-index';
  delete process.env.PINECONE_HOST;

  const pineconeSdk = require('@pinecone-database/pinecone');

  const originalIndex = pineconeSdk.Pinecone.prototype.index;
  const captured = { namespace: null, arg: null };

  pineconeSdk.Pinecone.prototype.index = function mockIndex() {
    return {
      namespace(ns) {
        captured.namespace = ns;
        return {
          async deleteMany(arg) {
            captured.arg = arg;
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
  const filter = { tenantId: 't_1', projectId: 'p_1' };

  const r = await pinecone.deleteByFilter({ namespace: 'ns_1', filter, bestEffort: false });
  assert.deepEqual(r, { ok: true });
  assert.equal(captured.namespace, 'ns_1');
  assert.deepEqual(captured.arg, filter);
});

