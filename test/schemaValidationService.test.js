const test = require('node:test');
const assert = require('node:assert/strict');

const { withDefaultMaintenanceFields } = require('../services/schemaValidationService');

test('withDefaultMaintenanceFields strips scheduling fields from maintenance data fields', () => {
  const fields = withDefaultMaintenanceFields('maintenance', [
    { key: 'cycleValue', label: 'Cycle value', fieldType: 'number' },
    { key: 'cycleUnit', label: 'Cycle unit', fieldType: 'select', options: ['week'] },
    { key: 'startDate', label: 'Start date', fieldType: 'date' },
    { label: 'Notes', fieldType: 'textarea' }
  ]);

  assert.deepEqual(fields.map((field) => field.key), ['notes']);
});

test('withDefaultMaintenanceFields strips scheduling fields even when mixed with normal fields', () => {
  const fields = withDefaultMaintenanceFields('maintenance', [
    { key: 'cycleValue', label: 'Cycle value', fieldType: 'number' },
    { label: 'Result', fieldType: 'text' }
  ]);

  assert.deepEqual(fields.map((field) => field.key), ['result']);
});

test('withDefaultMaintenanceFields keeps normal compliance fields', () => {
  const fields = withDefaultMaintenanceFields('compliance', [
    { label: 'Result', fieldType: 'text' }
  ]);

  assert.deepEqual(fields.map((field) => field.key), ['result']);
});
