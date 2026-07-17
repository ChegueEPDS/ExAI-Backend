const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProtectionTypes, normalizeProtectionMethodTypes } = require('../helpers/protectionTypes');

test('normalizeProtectionTypes preserves nA and does not turn it into NA placeholder', () => {
  const out = normalizeProtectionTypes('Ex nA IIC T6 Gc');
  assert.ok(out.includes('nA'), `Expected to include "nA", got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('NA'), `Did not expect placeholder "NA", got: ${JSON.stringify(out)}`);
});

test('normalizeProtectionMethodTypes preserves db when it is the protection method', () => {
  assert.deepEqual(normalizeProtectionMethodTypes('db'), ['db']);
  assert.deepEqual(normalizeProtectionMethodTypes('Ex db IIIC T120 °C'), ['db']);
});

test('generic protection normalization still ignores Db when it is an EPL token', () => {
  assert.deepEqual(normalizeProtectionTypes('Ex t IIIC T120 °C Db'), ['t']);
});
