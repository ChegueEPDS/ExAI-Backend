const test = require('node:test');
const assert = require('node:assert/strict');

const tableQuery = require('../services/tableQueryService');
const tabularPreview = require('../services/tabularPreviewService');

test('tabular preview parses row-chunk key=value pairs', () => {
  const txt = [
    'FILE=a.xlsx',
    'SHEET=Sheet1',
    'ROW_INDEX=2',
    'Date=2026-01-01 | Amount=1 234,50 Ft | Project=Alpha',
  ].join('\n');
  const obj = tabularPreview.__test.parseRowChunkText(txt);
  assert.equal(obj.Date, '2026-01-01');
  assert.equal(obj.Amount, '1 234,50 Ft');
  assert.equal(obj.Project, 'Alpha');
});

test('table query filter supports contains/in/between and numeric comparisons', () => {
  const r = { Name: 'Alice', Amount: '1234.5', Month: '01' };

  assert.equal(tableQuery.__test.applyFilter(r, { column: 'name', op: 'contains', value: 'ali' }), true);
  assert.equal(tableQuery.__test.applyFilter(r, { column: 'name', op: 'contains', value: 'bob' }), false);

  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Month', op: 'in', value: ['01', '02'] }), true);
  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Month', op: 'in', value: ['03'] }), false);

  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Amount', op: '>', value: 1000 }), true);
  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Amount', op: '<', value: 10 }), false);

  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Amount', op: 'between', value: 1200, value2: 1300 }), true);
  assert.equal(tableQuery.__test.applyFilter(r, { column: 'Amount', op: 'between', value: 1, value2: 10 }), false);
});

test('table query aggregateRows returns null for raw mode', () => {
  const rows = [{ A: '1' }, { A: '2' }];
  const out = tableQuery.__test.aggregateRows(rows, { groupBy: [], aggregations: [] });
  assert.equal(out, null);
});

