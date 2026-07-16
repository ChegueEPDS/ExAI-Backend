const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEquipmentSearchFields,
  buildSearchTrigrams,
  normalizeEquipmentSearchValue
} = require('../helpers/equipmentSearch');

test('normalizes equipment search text without accents or case differences', () => {
  assert.equal(normalizeEquipmentSearchValue('  ÁrVÍz TÜKÖR  '), 'arviz tukor');
});

test('builds unique trigrams that preserve substring matching', () => {
  assert.deepEqual(buildSearchTrigrams('ABABA'), ['aba', 'bab']);
});

test('builds normalized search fields from the existing searchable equipment fields', () => {
  const fields = buildEquipmentSearchFields({
    TagNo: 'PÜMP-01',
    Manufacturer: 'Müller',
    'Serial Number': 'SN 42'
  });
  assert.equal(fields.searchNormalized, 'pump-01 muller sn 42');
  assert.ok(fields.searchTrigrams.includes('mul'));
  assert.ok(fields.searchTrigrams.includes('n 4'));
});
