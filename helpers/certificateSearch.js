function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLooseCertNoRegex(value = '') {
  const normalized = String(value || '').replace(/[^0-9A-Za-z]/g, '');
  if (!normalized) return null;

  const pattern = normalized
    .split('')
    .map(ch => escapeRegex(ch))
    .join('[^0-9A-Za-z]*');

  return new RegExp(pattern, 'i');
}

function buildSubstringRegex(value = '') {
  const source = String(value || '').trim();
  if (!source) return null;
  return new RegExp(escapeRegex(source), 'i');
}

module.exports = {
  buildLooseCertNoRegex,
  buildSubstringRegex
};
