const test = require('node:test');
const assert = require('node:assert/strict');

const { validateAndCleanDataplateFields, _internals } = require('../helpers/dataplateFieldValidators');

test('IP rating validator accepts common IP patterns and rejects others', () => {
  assert.deepEqual(_internals.isValidIpRating(''), { ok: true, value: '' });
  assert.equal(_internals.isValidIpRating('IP 65').ok, true);
  assert.equal(_internals.isValidIpRating('ip65').value, 'IP65');
  assert.equal(_internals.isValidIpRating('IPX5').value, 'IPX5');
  assert.equal(_internals.isValidIpRating('IP6X').value, 'IP6X');
  assert.equal(_internals.isValidIpRating('IP69K').value, 'IP69K');
  assert.equal(_internals.isValidIpRating('IP66, IP67').value, 'IP66, IP67');

  const bad = _internals.isValidIpRating('IP6S'); // common OCR, but should be repaired later, not accepted as-is
  assert.equal(bad.ok, false);
});

test('Certificate No validator keeps only plausible ATEX/IECEx tokens', () => {
  const ok1 = _internals.normalizeAndValidateCertificateNo('BVS 14 ATEX E 1234 X');
  assert.equal(ok1.ok, true);
  assert.ok(ok1.value.toUpperCase().includes('ATEX'));

  const ok2 = _internals.normalizeAndValidateCertificateNo('IEC EX BAS 17.0001X');
  assert.equal(ok2.ok, true);
  assert.ok(ok2.value.startsWith('IECEx'));

  const mixed = _internals.normalizeAndValidateCertificateNo('IECEx BAS 17.0001X, garbage, BVS 14 ATEX E 1234 X');
  assert.equal(mixed.ok, true);
  assert.ok(mixed.value.includes('IECEx'));
  assert.ok(mixed.value.toUpperCase().includes('ATEX'));
  assert.ok(Array.isArray(mixed.warnings) && mixed.warnings.length >= 1);

  const bad = _internals.normalizeAndValidateCertificateNo('NOT_A_CERT');
  assert.equal(bad.ok, false);
});

test('Certificate No validator normalizes CERT.* prefixes and drops substring duplicates', () => {
  const c1 = _internals.normalizeAndValidateCertificateNo('CERT.CESI 03 ATEX 010, CESI 03 ATEX 010');
  assert.equal(c1.ok, true);
  assert.equal(c1.value, 'CESI 03 ATEX 010');

  const c2 = _internals.normalizeAndValidateCertificateNo('0722 TUV IT 14ATEX065X, IT 14ATEX065X');
  assert.equal(c2.ok, true);
  assert.equal(c2.value, '0722 TUV IT 14ATEX065X');
});

test('validateAndCleanDataplateFields rejects invalid IP/Cert and drops invalid Ex rows', () => {
  const input = {
    Manufacturer: 'ACME',
    'Model/Type': 'X1',
    'Serial Number': '123',
    'Equipment Type': 'Motor',
    'IP rating': 'IP6S',
    'Certificate No': 'NOT_A_CERT',
    'Max Ambient Temp': '+40',
    'Other Info': '',
    Compliance: 'NA',
    'Ex Marking': [
      {
        Marking: 'II 2G', // missing Ex token + other required fields
        'Equipment Group': 'II',
        'Equipment Category': '2',
        Environment: 'G',
        'Type of Protection': 'd',
        'Gas / Dust Group': 'IIC',
        'Temperature Class': 'T4',
        'Equipment Protection Level': 'Gb',
      },
      {
        Marking: 'II 2G Ex d IIC T4 Gb',
        'Equipment Group': '',
        'Equipment Category': '',
        Environment: '',
        'Type of Protection': '',
        'Gas / Dust Group': '',
        'Temperature Class': '',
        'Equipment Protection Level': '',
      },
    ],
  };

  const out = validateAndCleanDataplateFields(input);
  assert.equal(out.fields['IP rating'], '');
  assert.equal(out.fields['Certificate No'], '');
  assert.equal(Array.isArray(out.fields['Ex Marking']), true);
  assert.equal(out.fields['Ex Marking'].length, 1);
  assert.equal(out.fields['Ex Marking'][0].Marking, 'II 2G Ex d IIC T4 Gb');
  assert.ok(out.warnings.length >= 2);
});

test('validateAndCleanDataplateFields derives temp class from glued token like T3Gb', () => {
  const input = {
    Manufacturer: 'ACME',
    'Model/Type': 'X1',
    'Serial Number': '123',
    'Equipment Type': 'Motor',
    'IP rating': 'IP55',
    'Certificate No': '0722 TUV IT 14ATEX065X',
    'Max Ambient Temp': '',
    'Other Info': '',
    Compliance: 'NA',
    'Ex Marking': [
      {
        Marking: 'II 2G Ex d IIB T3Gb IP55',
        'Equipment Group': '',
        'Equipment Category': '',
        Environment: '',
        'Type of Protection': '',
        'Gas / Dust Group': '',
        'Temperature Class': '',
        'Equipment Protection Level': '',
      },
    ],
  };

  const out = validateAndCleanDataplateFields(input);
  assert.equal(out.fields['Ex Marking'].length, 1);
  assert.equal(out.fields['Ex Marking'][0]['Temperature Class'], 'T3');
  assert.equal(out.fields['Ex Marking'][0]['Equipment Protection Level'], 'Gb');
});
