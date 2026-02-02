const test = require('node:test');
const assert = require('node:assert/strict');

const { enabled, detectIntent } = require('../services/measurementEvaluatorService');

test('measurement evaluator intent detection', () => {
  assert.equal(detectIntent('Evaluate Excel measurement data and compare to limits'), true);
  assert.equal(detectIntent('Kérlek készíts kockázatértékelést a mérési adatok alapján'), true);
  assert.equal(detectIntent('Hello world'), false);
});

test('measurement evaluator enabled flag parsing', () => {
  const prev = process.env.MEAS_EVAL_ENABLED;
  process.env.MEAS_EVAL_ENABLED = '1';
  assert.equal(enabled(), true);
  process.env.MEAS_EVAL_ENABLED = '0';
  assert.equal(enabled(), false);
  process.env.MEAS_EVAL_ENABLED = prev;
});

