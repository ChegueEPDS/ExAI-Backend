const test = require('node:test');
const assert = require('node:assert/strict');

test('deleteAll calls Pinecone namespace().deleteAll()', async (t) => {
  const savedEnv = { ...process.env };
  process.env.PINECONE_API_KEY = 'test-key';
  process.env.PINECONE_INDEX = 'test-index';
  delete process.env.PINECONE_HOST;

  const pineconeSdk = require('@pinecone-database/pinecone');
  const originalIndex = pineconeSdk.Pinecone.prototype.index;

  const captured = { namespace: null, called: 0 };
  pineconeSdk.Pinecone.prototype.index = function mockIndex() {
    return {
      namespace(ns) {
        captured.namespace = ns;
        return {
          async deleteAll() {
            captured.called += 1;
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

  const r = await pinecone.deleteAll({ namespace: 'ns_1', bestEffort: false });
  assert.deepEqual(r, { ok: true });
  assert.equal(captured.namespace, 'ns_1');
  assert.equal(captured.called, 1);
});

