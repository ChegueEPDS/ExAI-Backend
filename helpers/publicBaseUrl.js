const tenantSettingsStore = require('../services/tenantSettingsStore');
const { getRequestBaseUrl } = require('./requestBaseUrl');

function normalizeOriginLike(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function isLocalhostBaseUrl(baseUrl) {
  const normalized = normalizeOriginLike(baseUrl);
  if (!normalized) return false;
  try {
    const u = new URL(normalized);
    const host = String(u.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function resolvePublicBaseUrl({ req, tenantId } = {}) {
  const fromRequest = getRequestBaseUrl(req);
  if (fromRequest) return fromRequest;

  if (tenantId) {
    const v = await tenantSettingsStore.getEffectiveValue(String(tenantId), 'PUBLIC_BASE_URL');
    const normalized = normalizeOriginLike(v);
    if (normalized) return normalized;
  }

  const env = process.env.APP_PUBLIC_BASE_URL || process.env.APP_BASE_URL_CERTS || '';
  return normalizeOriginLike(env);
}

async function persistPublicBaseUrlIfMissing({ tenantId, baseUrl, updatedBy = null } = {}) {
  const t = String(tenantId || '').trim();
  const normalized = normalizeOriginLike(baseUrl);
  if (!t || !normalized) return;
  if (isLocalhostBaseUrl(normalized)) return;

  const current = await tenantSettingsStore.getEffectiveValue(t, 'PUBLIC_BASE_URL');
  if (String(current || '').trim()) return;

  await tenantSettingsStore.setMany(t, { PUBLIC_BASE_URL: normalized }, { updatedBy });
}

module.exports = {
  resolvePublicBaseUrl,
  persistPublicBaseUrlIfMissing,
  _private: { normalizeOriginLike, isLocalhostBaseUrl },
};

