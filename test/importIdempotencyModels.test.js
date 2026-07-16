const test = require('node:test');
const assert = require('node:assert/strict');

const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');

function findIndex(model, name) {
  return model.schema.indexes().find(([, options]) => options.name === name);
}

test('equipment import rows have a partial unique idempotency index', () => {
  const index = findIndex(Equipment, 'uniq_equipment_import_row');
  assert.ok(index);
  assert.deepEqual(index[0], {
    tenantId: 1,
    'importMeta.jobId': 1,
    'importMeta.rowKey': 1
  });
  assert.equal(index[1].unique, true);
  assert.ok(index[1].partialFilterExpression);
});

test('imported inspections have a partial unique idempotency index', () => {
  const index = findIndex(Inspection, 'uniq_inspection_import_key');
  assert.ok(index);
  assert.deepEqual(index[0], { tenantId: 1, importKey: 1 });
  assert.equal(index[1].unique, true);
  assert.ok(index[1].partialFilterExpression);
});
