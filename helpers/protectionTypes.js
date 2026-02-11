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

// Build canonical mapping while preserving distinct codes like "nA" vs placeholder "NA".
// We must not let placeholder "NA" overwrite the real protection type "nA".
const CANONICAL_BY_LOWER = new Map();
for (const v of PROTECTION_TYPE_VALUES) {
  const key = String(v || '').toLowerCase();
  if (!key) continue;
  if (CANONICAL_BY_LOWER.has(key)) continue; // first occurrence wins (keeps nA)
  CANONICAL_BY_LOWER.set(key, v);
}
const KNOWN_SET_LOWER = new Set(PROTECTION_TYPE_VALUES.map((v) => v.toLowerCase()));

const NOISE_TOKENS = new Set([
  'ex',
  'atex',
  'iecex',
  'type',
  'of',
  'protection'
]);

const NON_PROTECTION_TOKENS = new Set([
  // Gas/dust groups
  'iia',
  'iib',
  'iic',
  'iiia',
  'iiib',
  'iiic',
  // EPL
  'ga',
  'gb',
  'gc',
  'da',
  'db',
  'dc',
  // Common noise in Ex lines (environment)
  'gd',
  'dg'
]);

function looksLikeProtectionCode(token) {
  // Allow unknown-but-code-like short tokens such as "tg"
  return /^[a-z]{1,5}[0-9]{0,2}$/.test(token);
}

function normalizeProtectionTypes(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const s = raw
    .replace(/[“”"']/g, ' ')
    .replace(/°\s*C/gi, ' ')
    .replace(/℃/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!s) return [];

  // Keep original token casing so we can treat placeholder "NA" differently from "nA".
  const wordsRaw = s.match(/[A-Za-z0-9]+/g) || [];
  const found = [];
  for (let i = 0; i < wordsRaw.length; i += 1) {
    const original = String(wordsRaw[i] || '');
    if (!original) continue;
    // Treat "NA" (all-caps) as a placeholder, not a protection type.
    if (original === 'NA') continue;

    const w = original.toLowerCase();
    if (NOISE_TOKENS.has(w)) continue;
    if (NON_PROTECTION_TOKENS.has(w)) continue;
    if (/^t[1-6]$/.test(w) || /^t\d{2,3}$/.test(w)) continue;
    if (w === 'op' && i + 1 < wordsRaw.length) {
      const next = String(wordsRaw[i + 1] || '').toLowerCase();
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
    return out;
  }
  return out;
}

module.exports = { PROTECTION_TYPE_VALUES, KNOWN_SET_LOWER, normalizeProtectionTypes };
