const Certificate = require('../models/certificate');

const normalizeCertNo = (s = '') =>
  String(s || '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toLowerCase();

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function candidateCertNos(certNoRaw) {
  const out = new Set();
  const raw = String(certNoRaw || '').trim();
  if (!raw) return [];
  raw
    .split(/[/,;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const norm = normalizeCertNo(part);
      if (norm) out.add(norm);
    });
  const wholeNorm = normalizeCertNo(raw);
  if (wholeNorm) out.add(wholeNorm);
  return Array.from(out);
}

async function buildCertificateCacheForCertNos(tenantId, certNosRaw) {
  const wanted = new Set((certNosRaw || []).flatMap(candidateCertNos));
  if (!wanted.size) return new Map();

  const rawCandidates = Array.from(
    new Set(
      (certNosRaw || [])
        .flatMap((certNoRaw) => String(certNoRaw || '').split(/[/,;]/).concat(String(certNoRaw || '')))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, 250);
  if (!rawCandidates.length) return new Map();

  const query = {
    certNo: { $ne: null },
    $and: [
      { $or: [{ visibility: 'public' }, ...(tenantId ? [{ tenantId }] : [])] },
      {
        $or: rawCandidates.map((value) => ({
          certNo: { $regex: `^${escapeRegex(value)}$`, $options: 'i' }
        }))
      }
    ]
  };

  const docs = await Certificate.find(query)
    .select('_id certNo docType specCondition issueDate visibility manufacturer equipment tenantId scheme fileUrl sharePointFileUrl docxUrl sharePointDocxUrl alias name CertNo')
    .lean();
  const map = new Map();

  docs.forEach(doc => {
    const norm = normalizeCertNo(doc.certNo || '');
    if (!norm || !wanted.has(norm)) return;
    if (!map.has(norm)) map.set(norm, doc);
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
  buildCertificateCacheForCertNos,
  resolveCertificateFromCache
};
