const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../helpers/azureVisionOcr');

test('scoreOcrLines prefers dataplate-like OCR output', () => {
  const weak = ['random', 'text'];
  const strong = ['II 2G Ex d IIB T4 Gb', 'IP66', 'BVS 14 ATEX E 1234 X'];

  assert.ok(_internals.scoreOcrLines(strong) > _internals.scoreOcrLines(weak));
});

test('mergeOcrRuns keeps unique lines and upgrades better duplicates', () => {
  const merged = _internals.mergeOcrRuns([
    {
      name: 'base',
      score: 12,
      lines: ['ACME', 'II 2G Ex d IIB T4', 'IP6'],
    },
    {
      name: 'better',
      score: 15,
      lines: ['ACME', 'II 2G Ex d IIB T4 Gb', 'IP66', 'BVS 14 ATEX E 1234 X'],
    },
  ]);

  assert.ok(merged.extractedText.includes('II 2G Ex d IIB T4 Gb'));
  assert.ok(merged.extractedText.includes('IP66'));
  assert.ok(merged.extractedText.includes('BVS 14 ATEX E 1234 X'));
  assert.ok(!merged.extractedText.includes('IP6\n'));
});

test('mergeOcrRuns does not append low-signal noise from weaker runs', () => {
  const merged = _internals.mergeOcrRuns([
    {
      name: 'base',
      score: 20,
      lines: ['ABB', 'II 2G Ex d IIB T4 Gb', 'IECEx LCI 09.0009X'],
    },
    {
      name: 'weak',
      score: 8,
      lines: ['random crop artifact', 'more noise'],
    },
  ]);

  assert.ok(!merged.extractedText.includes('random crop artifact'));
  assert.ok(merged.extractedText.includes('II 2G Ex d IIB T4 Gb'));
});

test('buildCropSpecs returns stable candidate crops within image bounds', () => {
  const crops = _internals.buildCropSpecs({ width: 2000, height: 1200 });

  assert.ok(crops.length >= 3);
  for (const crop of crops) {
    assert.ok(crop.left >= 0);
    assert.ok(crop.top >= 0);
    assert.ok(crop.width > 0);
    assert.ok(crop.height > 0);
    assert.ok(crop.left + crop.width <= 2000);
    assert.ok(crop.top + crop.height <= 1200);
  }
});

test('isStrongDataplateRun only triggers for high-signal dataplate OCR', () => {
  assert.equal(
    _internals.isStrongDataplateRun(
      ['II 2G Ex d IIB T4 Gb', 'IP66', 'IECEx LCI 09.0009X'],
      _internals.scoreOcrLines(['II 2G Ex d IIB T4 Gb', 'IP66', 'IECEx LCI 09.0009X'])
    ),
    true
  );

  assert.equal(
    _internals.isStrongDataplateRun(
      ['Ex', 'some text', 'IP66'],
      _internals.scoreOcrLines(['Ex', 'some text', 'IP66'])
    ),
    false
  );
});
