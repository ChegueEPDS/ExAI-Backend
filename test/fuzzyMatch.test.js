const test = require('node:test');
const assert = require('node:assert/strict');

const { foldForSearch, bestWindowSimilarity, bestFuzzyMatch } = require('../helpers/fuzzyMatch');

test('foldForSearch removes diacritics and normalizes spacing', () => {
  assert.equal(foldForSearch('Árvíztűrő Tükörfúrógép!'), 'arvizturo tukorfurogep');
  assert.equal(foldForSearch('  IEC  60079-14  '), 'iec 60079 14');
});

test('bestWindowSimilarity tolerates minor typos', () => {
  const mf = foldForSearch('Használd a gaz cor setet');
  const sf = foldForSearch('GAS CORE');
  const sim = bestWindowSimilarity(mf, sf);
  assert.ok(sim > 0.7);
});

test('bestFuzzyMatch picks closest candidate above threshold', () => {
  const best = bestFuzzyMatch({
    message: 'gaz core',
    candidates: ['GAS_CORE', 'DUST_CORE', 'ATEX'],
    threshold: 0.7,
  });
  assert.ok(best);
  assert.equal(best.raw, 'GAS_CORE');
});

