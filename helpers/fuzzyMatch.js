function foldForSearch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s) return t.length;
  if (!t) return s.length;

  const n = s.length;
  const m = t.length;

  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

function similarity01(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  const maxLen = Math.max(aa.length, bb.length);
  if (!maxLen) return 1;
  const d = levenshteinDistance(aa, bb);
  return Math.max(0, 1 - d / maxLen);
}

function bestWindowSimilarity(messageFold, needleFold) {
  const mf = String(messageFold || '').trim();
  const nf = String(needleFold || '').trim();
  if (!mf || !nf) return 0;
  if (mf.includes(nf)) return 1;

  const mt = mf.split(' ').filter(Boolean);
  const nt = nf.split(' ').filter(Boolean);
  const m = nt.length;
  if (!m || mt.length < 1) return 0;
  if (m > 5) return similarity01(mf, nf) * 0.9;

  let best = 0;
  for (let i = 0; i <= mt.length - m; i += 1) {
    const win = mt.slice(i, i + m).join(' ');
    const sim = similarity01(win, nf);
    if (sim > best) best = sim;
    if (best >= 0.999) break;
  }
  if (mt.length < m) best = Math.max(best, similarity01(mt.join(' '), nf) * 0.95);
  return best;
}

function bestFuzzyMatch({ message, candidates, threshold = 0.86, maxNeedleLen = 80 }) {
  const mf = foldForSearch(message);
  if (!mf) return null;
  let best = null;
  for (const c of candidates || []) {
    const raw = String(c || '').trim();
    if (!raw) continue;
    const needle = foldForSearch(raw).slice(0, maxNeedleLen);
    if (!needle) continue;
    const sim = bestWindowSimilarity(mf, needle);
    if (sim < threshold) continue;
    const score = sim * 1000 + Math.min(40, needle.length);
    if (!best || score > best.score) best = { raw, needle, sim, score };
  }
  return best;
}

module.exports = {
  foldForSearch,
  levenshteinDistance,
  similarity01,
  bestWindowSimilarity,
  bestFuzzyMatch,
};

