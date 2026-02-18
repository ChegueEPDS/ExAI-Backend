function safeFirstHeaderToken(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

function isSafeHost(host) {
  if (!host) return false;
  if (/\s/.test(host)) return false;
  if (host.includes('/')) return false;
  return true;
}

/**
 * Best-effort public base URL for this request (scheme + host).
 * Prefers Origin (browser) then X-Forwarded-* then Host.
 * Returns null if it can't determine a safe host.
 */
function getRequestBaseUrl(req) {
  const origin = safeFirstHeaderToken(req?.get?.('origin'));
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin);
      if (isSafeHost(u.host)) return `${u.protocol}//${u.host}`;
    } catch {
      // ignore
    }
  }

  const forwardedProto = safeFirstHeaderToken(req?.get?.('x-forwarded-proto'));
  const protoRaw = forwardedProto || req?.protocol || 'https';
  const proto = protoRaw === 'http' ? 'http' : 'https';

  const forwardedHost = safeFirstHeaderToken(req?.get?.('x-forwarded-host'));
  const host = forwardedHost || safeFirstHeaderToken(req?.get?.('host'));
  if (!isSafeHost(host)) return null;

  return `${proto}://${host}`;
}

module.exports = { getRequestBaseUrl };

