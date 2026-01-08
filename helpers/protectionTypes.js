const PROTECTION_TYPE_VALUES = [
  'b',
  'c',
  'd',
  'da',
  'db',
  'dc',
  'e',
  'eb',
  'ec',
  'h',
  'i',
  'ia',
  'iaD',
  'ib',
  'ibD',
  'ic',
  'icD',
  'iD',
  'k',
  'm',
  'ma',
  'maD',
  'mb',
  'mbD',
  'mc',
  'mcD',
  'mD',
  'n',
  'nA',
  'nC',
  'nL',
  'nP',
  'nR',
  'o',
  'ob',
  'oc',
  'op',
  'op is',
  'op pr',
  'op sh',
  'p',
  'pb',
  'pc',
  'pD',
  'px',
  'pxb',
  'py',
  'pyb',
  'pz',
  'pzc',
  'q',
  'qb',
  's',
  'sa',
  'sb',
  'sc',
  't',
  'ta',
  'taD',
  'tb',
  'tbD',
  'tc',
  'tcD',
  'tD',
  'pv',
  'vc',
  'NA'
];

const CANONICAL_BY_LOWER = new Map(PROTECTION_TYPE_VALUES.map((v) => [v.toLowerCase(), v]));
const KNOWN_SET_LOWER = new Set(PROTECTION_TYPE_VALUES.map((v) => v.toLowerCase()));

const NOISE_TOKENS = new Set([
  'ex',
  'atex',
  'iecex',
  'type',
  'of',
  'protection'
]);

function looksLikeProtectionCode(token) {
  // Allow unknown-but-code-like short tokens such as "tg"
  return /^[a-z]{1,5}[0-9]{0,2}$/.test(token);
}

function normalizeProtectionTypes(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const s = raw
    .replace(/[“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!s) return [];

  const words = s.match(/[a-z0-9]+/g) || [];
  const found = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (NOISE_TOKENS.has(w)) continue;
    if (w === 'op' && i + 1 < words.length) {
      const next = words[i + 1];
      const phrase = `op ${next}`;
      if (CANONICAL_BY_LOWER.has(phrase)) {
        found.push(CANONICAL_BY_LOWER.get(phrase));
        i += 1;
        continue;
      }
    }
    if (CANONICAL_BY_LOWER.has(w)) {
      found.push(CANONICAL_BY_LOWER.get(w));
      continue;
    }
    if (looksLikeProtectionCode(w)) {
      found.push(w);
    }
  }

  const out = [];
  const seen = new Set();
  for (const v of found) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  if (out.length > 1) {
    return out.filter((v) => v.toLowerCase() !== 'na');
  }
  return out;
}

module.exports = { PROTECTION_TYPE_VALUES, KNOWN_SET_LOWER, normalizeProtectionTypes };
