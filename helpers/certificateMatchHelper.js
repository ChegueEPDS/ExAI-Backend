const Certificate = require('../models/certificate');

const normalizeCertNo = (s = '') =>
  String(s || '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toLowerCase();

async function buildCertificateCacheForTenant(tenantId) {
  const query = {
    certNo: { $ne: null },
    $or: [{ visibility: 'public' }]
  };

  if (tenantId) {
    query.$or.push({ tenantId });
  }

  const docs = await Certificate.find(query).lean();
  const map = new Map();

  docs.forEach(doc => {
    const norm = normalizeCertNo(doc.certNo || '');
    if (!norm) return;
    if (!map.has(norm)) {
      map.set(norm, doc);
    }
  });

  return map;
}

function resolveCertificateFromCache(certMap, certNoRaw) {
  if (!certMap || !certNoRaw) return null;

  const parts = String(certNoRaw)
    .split(/[/,;]/)
    .map(part => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const norm = normalizeCertNo(part);
    if (!norm) continue;
    const hit = certMap.get(norm);
    if (hit) return hit;
  }

  const wholeNorm = normalizeCertNo(certNoRaw);
  if (wholeNorm) {
    return certMap.get(wholeNorm) || null;
  }

  return null;
}

module.exports = {
  normalizeCertNo,
  buildCertificateCacheForTenant,
  resolveCertificateFromCache
};
