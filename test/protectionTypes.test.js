const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProtectionTypes } = require('../helpers/protectionTypes');

test('normalizeProtectionTypes preserves nA and does not turn it into NA placeholder', () => {
  const out = normalizeProtectionTypes('Ex nA IIC T6 Gc');
  assert.ok(out.includes('nA'), `Expected to include "nA", got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('NA'), `Did not expect placeholder "NA", got: ${JSON.stringify(out)}`);
});

