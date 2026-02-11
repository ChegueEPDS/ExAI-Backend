const test = require('node:test');
const assert = require('node:assert/strict');

const { enabled, detectIntent } = require('../services/measurementEvaluatorService');
const systemSettings = require('../services/systemSettingsStore');

test('measurement evaluator intent detection', () => {
  assert.equal(detectIntent('Evaluate Excel measurement data and compare to limits'), true);
  assert.equal(detectIntent('Kérlek készíts kockázatértékelést a mérési adatok alapján'), true);
  assert.equal(detectIntent('Hello world'), false);
});

test('measurement evaluator enabled flag parsing', () => {
  systemSettings._resetInMemoryForTests();
  systemSettings._setInMemoryForTests({ MEAS_EVAL_ENABLED: true });
  assert.equal(enabled(), true);
  systemSettings._setInMemoryForTests({ MEAS_EVAL_ENABLED: false });
  assert.equal(enabled(), false);
  systemSettings._resetInMemoryForTests();
});
