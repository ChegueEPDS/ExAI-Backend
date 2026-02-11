const test = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../services/xlsxPlannerService');
const systemSettings = require('../services/systemSettingsStore');

test('xlsx planner normalizes tool aliases', () => {
  assert.equal(planner.__test.normalizeTool('analyze'), 'analyze_measurement_tables');
  assert.equal(planner.__test.normalizeTool('analyze_tables'), 'analyze_measurement_tables');
  assert.equal(planner.__test.normalizeTool('analyze_measurement_tables'), 'analyze_measurement_tables');
  assert.equal(planner.__test.normalizeTool('compare'), 'compare_tables');
  assert.equal(planner.__test.normalizeTool('evaluate'), 'evaluate_measurements');
  assert.equal(planner.__test.normalizeTool('none'), 'none');
});

test('xlsx planner sanitizes plan args safely', () => {
  const plan = planner.__test.sanitizePlan({
    steps: [{ tool: 'analyze', args: { column_range: 'C-K', tables: [1, 2, 3, 4] } }],
  });
  assert.equal(plan.steps[0].tool, 'analyze_measurement_tables');
  assert.equal(plan.steps[0].args.column_range, 'C-K');
  assert.deepEqual(plan.steps[0].args.tables, [1, 2, 3, 4]);
});

test('xlsx planner hard-rules engineering compare (no stats)', async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test';
  systemSettings._resetInMemoryForTests();
  systemSettings._setInMemoryForTests({ XLSX_PLANNER_ENABLED: true });
  try {
    const msg = 'You have at your disposal the file MIN measurement data. Perform a comparative analysis of Table 1 to Table 4 to find significant differences in temperatures, in columns C to K';
    const r = await planner.buildPlan({ message: msg, xlsxHints: { xlsxFiles: ['MIN.xlsx'] } });
    assert.equal(r.ok, true);
    assert.equal(r.plan.steps[0].tool, 'analyze_measurement_tables');
    assert.equal(r.plan.needs_clarification, false);
    assert.equal(r.plan.steps[0].args.column_range, 'C-K');
  } finally {
    process.env.OPENAI_API_KEY = prevKey;
    systemSettings._resetInMemoryForTests();
  }
});
