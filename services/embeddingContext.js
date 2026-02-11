const systemSettings = require('./systemSettingsStore');

function isContextHeaderEnabled() {
  return !!systemSettings.getBoolean('EMBEDDING_CONTEXT_HEADER_ENABLED');
}

function getEmbeddingFormatVersion() {
  if (!isContextHeaderEnabled()) return 0;
  const v = Number(systemSettings.getNumber('EMBEDDING_CONTEXT_HEADER_VERSION') || 1);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

function normalizeHeaderValue(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Keep ASCII-ish to reduce weird tokenization; preserve common symbols used in IDs.
  return s.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildEmbeddingText({ kind, fields = {}, text = '' }) {
  const body = String(text ?? '');
  if (!isContextHeaderEnabled()) return body;

  const lines = [];
  lines.push(`KIND=${normalizeHeaderValue(kind) || 'unknown'}`);
  lines.push(`EMBEDDING_FORMAT=v${getEmbeddingFormatVersion()}`);

  const orderedKeys = Object.keys(fields || {});
  orderedKeys.sort((a, b) => String(a).localeCompare(String(b)));
  for (const key of orderedKeys) {
    const val = normalizeHeaderValue(fields[key]);
    if (!val) continue;
    // Avoid unbounded headers (we want the content to dominate).
    lines.push(`${key.toUpperCase()}=${val}`);
    if (lines.length >= 24) break;
  }

  const header = lines.join('\n').slice(0, 900);
  return `${header}\n\n${body}`;
}

module.exports = {
  isContextHeaderEnabled,
  getEmbeddingFormatVersion,
  buildEmbeddingText,
};

