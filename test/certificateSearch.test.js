const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLooseCertNoRegex, buildSubstringRegex } = require('../helpers/certificateSearch');

test('certificate number search matches numeric fragments anywhere in certNo', () => {
  const rx = buildLooseCertNoRegex('029');

  assert.ok(rx.test('06 ATEX 029 X'));
  assert.ok(rx.test('05ATEX 029X'));
  assert.ok(rx.test('CESI01ATEX029'));
});

test('certificate number search ignores separators in query and certificate number', () => {
  const rx = buildLooseCertNoRegex('ATEX 029 X');

  assert.ok(rx.test('06 ATEX 029 X'));
  assert.ok(rx.test('05ATEX029X'));
  assert.ok(rx.test('CESI01-ATEX-029-X'));
});

test('certificate number search returns null for empty normalized input', () => {
  assert.equal(buildLooseCertNoRegex(' - / '), null);
});

test('manufacturer search matches substrings anywhere in manufacturer name', () => {
  const rx = buildSubstringRegex('karl');

  assert.ok(rx.test('KARL Lutz'));
  assert.ok(rx.test('Po Karl Lutz'));
});

test('manufacturer search escapes regex metacharacters', () => {
  const rx = buildSubstringRegex('A.B');

  assert.ok(rx.test('Po A.B Lutz'));
  assert.equal(rx.test('Po AxxB Lutz'), false);
});
