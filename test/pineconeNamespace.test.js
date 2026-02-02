const test = require('node:test');
const assert = require('node:assert/strict');

test('resolveNamespace produces ASCII-printable namespace', () => {
  const pinecone = require('../services/pineconeService');
  const ns = pinecone.resolveNamespace({
    tenantId: '68c4717933e6174992e7874a',
    projectId: 'Elemezd a projektet kovkázat és szabványi megfelelés szempontjából!',
  });
  assert.equal(typeof ns, 'string');
  assert.ok(ns.length > 0);
  // Pinecone requires ASCII-printable characters in namespace name.
  assert.ok(/^[\x20-\x7E]+$/.test(ns), `non-ascii in namespace: ${ns}`);
});

