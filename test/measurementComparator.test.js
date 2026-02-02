const test = require('node:test');
const assert = require('node:assert/strict');

const meas = require('../services/measurementEvaluatorService');

test('measurement comparator intent detection (Table 1-4, columns C-K)', () => {
  const q = 'Perform a comparative analysis of Table 1 to Table 4 to find significant differences in temperatures, in columns C to K';
  assert.equal(meas.detectCompareTablesIntent(q), true);
});

test('tokenFromLabel ignores sheet token like T50 and parses T1 from Parameters', () => {
  const rowText = [
    'FILE=MIN.xlsx',
    'SHEET=12-2 345SOT M HEX3 T50',
    'ROW_INDEX=17',
    'Parameters=T1 - driver Tc point | Value=[°C] | C=21.5 | D=26.7'
  ].join('\n');
  assert.equal(meas.__test.extractRowLabelFromRowText(rowText), 'T1 - driver Tc point');
  assert.equal(meas.__test.extractUnitFromRowText(rowText), '[°C]');
  assert.equal(meas.__test.tokenFromLabel(rowText), 'T1');
});
