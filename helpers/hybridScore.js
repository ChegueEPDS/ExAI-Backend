function fold(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractKeywordNeedles(query) {
  const q = String(query || '');
  const needles = new Set();

  // Keep explicit Ex tokens and common compliance markers.
  const re = /\b(Ex\s*(?:d|db|e|eb|p|i|m|mb|t|tb|tc)|IIC|IIB|IIA|IIIC|IIIB|IIIA|Ga|Gb|Gc|Da|Db|Dc|T[1-6]|IP\d{1,2}X?|Zone\s*\d{1,2}|2G|2D|1G|1D|3G|3D)\b/gi;
  let m;
  while ((m = re.exec(q)) !== null) {
    needles.add(m[0]);
  }

  // Clause-like tokens (e.g. "6.2.3", "29.3.1")
  const clause = q.match(/\b\d+(?:\.\d+){1,6}\b/g) || [];
  clause.forEach(x => needles.add(x));

  // Standard number tokens
  const std = q.match(/\b\d{4,5}\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3})?\b/g) || [];
  std.forEach(x => needles.add(x.replace(/\s+/g, '')));

  // A few top query words (length >=4)
  const words = fold(q).split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  for (const w of words.slice(0, 10)) needles.add(w);

  return Array.from(needles).slice(0, 24);
}

function keywordScore({ query, text }) {
  const needles = extractKeywordNeedles(query);
  const hay = fold(text);
  if (!hay) return 0;
  let score = 0;
  for (const n0 of needles) {
    const n = fold(n0);
    if (!n) continue;
    if (hay.includes(n)) {
      score += n.length >= 6 ? 4 : 2;
    }
  }
  // Normalize to ~0..1 range
  return Math.min(1, score / 40);
}

module.exports = {
  keywordScore,
  extractKeywordNeedles,
};

