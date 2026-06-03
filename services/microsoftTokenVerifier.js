const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

let cachedKeys = null;
let cachedKeysUntil = 0;

function tenantId() {
  return process.env.AZURE_TENANT_ID || process.env.MICROSOFT_TENANT_ID || 'common';
}

function clientIds() {
  return String(
    process.env.AZURE_CLIENT_ID ||
    process.env.MICROSOFT_CLIENT_ID ||
    process.env.MS_CLIENT_ID ||
    ''
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function allowedIssuers(tid) {
  const configured = String(process.env.MICROSOFT_TOKEN_ISSUERS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return [
    `https://login.microsoftonline.com/${tid}/v2.0`,
    `https://sts.windows.net/${tid}/`,
  ];
}

async function getMicrosoftJwks() {
  const now = Date.now();
  if (cachedKeys && cachedKeysUntil > now) return cachedKeys;

  const tid = tenantId();
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tid)}/discovery/v2.0/keys`;
  const res = await axios.get(url, { timeout: 8000 });
  cachedKeys = Array.isArray(res.data?.keys) ? res.data.keys : [];
  cachedKeysUntil = now + 60 * 60_000;
  return cachedKeys;
}

async function verifyMicrosoftAccessToken(accessToken) {
  const decoded = jwt.decode(accessToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error('Invalid Microsoft token header');

  const keys = await getMicrosoftJwks();
  const jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    cachedKeysUntil = 0;
    throw new Error('Microsoft signing key not found');
  }

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const audiences = clientIds();
  if (!audiences.length) throw new Error('Missing Microsoft client id');

  const verified = jwt.verify(accessToken, publicKey, {
    algorithms: ['RS256'],
    audience: audiences,
  });

  const tid = verified.tid || tenantId();
  const issuers = allowedIssuers(tid);
  if (!issuers.includes(verified.iss)) {
    throw new Error('Invalid Microsoft token issuer');
  }

  return verified;
}

module.exports = { verifyMicrosoftAccessToken };
