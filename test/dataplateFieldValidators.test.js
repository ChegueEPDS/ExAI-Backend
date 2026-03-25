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
  assert.equal(_internals.isValidIpRating('IP66 & IP67').value, 'IP66, IP67');
  assert.equal(_internals.isValidIpRating('IP55A').value, 'IP55');

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

test('extractFromMarking handles spaced subgroup and omitted leading category tokens', () => {
  const parsed = _internals.extractFromMarking('Ex de II B T4 Gb');
  assert.equal(parsed.equipmentGroup, 'II');
  assert.equal(parsed.environment, 'G');
  assert.equal(parsed.gasDustGroup, 'IIB');
  assert.equal(parsed.temperatureClass, 'T4');
  assert.equal(parsed.epl, 'Gb');
});

test('normalizeEquipmentCategory accepts slash categories with OCR I/2 form', () => {
  assert.equal(_internals.normalizeEquipmentCategory('I/2'), '1/2');
  assert.equal(_internals.normalizeEquipmentCategory('I/3'), '1/3');
});

test('extractFromMarking keeps slash category for II 1/2G forms', () => {
  const parsed = _internals.extractFromMarking('II 1/2G Ex h IIB T3 Ga/Gb');
  assert.equal(parsed.equipmentGroup, 'II');
  assert.equal(parsed.equipmentCategory, '1/2');
  assert.equal(parsed.environment, 'G');
  assert.equal(parsed.gasDustGroup, 'IIB');
});

test('normalizeGasDustGroup prefers IIB over IIIB for Ex d OCR noise in group II context', () => {
  assert.equal(
    _internals.normalizeGasDustGroup('IIIB', { protection: 'd', equipmentGroup: 'II', environment: 'G' }),
    'IIB'
  );
});

test('validateAndCleanDataplateFields parses mixed gas/dust marking with slash category', () => {
  const input = {
    Manufacturer: 'Nadi',
    'Model/Type': 'C03T18DUC',
    'Serial Number': '47619/16',
    'Equipment Type': 'Valve',
    'IP rating': 'IP67',
    'Certificate No': 'EUMI 12 ATEX 0784',
    'Max Ambient Temp': '-20 /+40°C',
    'Other Info': '',
    Compliance: 'NA',
    'Ex Marking': [
      {
        Marking: 'II 1/2 GDc Ex d II C T5 Gb',
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
  assert.equal(out.fields['Ex Marking'][0]['Equipment Group'], 'II');
  assert.equal(out.fields['Ex Marking'][0]['Equipment Category'], '1/2');
  assert.equal(out.fields['Ex Marking'][0].Environment, 'GD');
  assert.equal(out.fields['Ex Marking'][0]['Gas / Dust Group'], 'IIC');
});
