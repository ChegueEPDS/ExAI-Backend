const { Pinecone } = require('@pinecone-database/pinecone');
const logger = require('../config/logger');
const crypto = require('crypto');
const systemSettings = require('./systemSettingsStore');

function pineconeDebugEnabled() {
  return systemSettings.getBoolean('DEBUG_PINECONE');
}

function isPineconeEnabled() {
  const raw = systemSettings.getEffectiveValue('PINECONE_ENABLED');
  // Explicit flag wins (so you can disable Pinecone without unsetting secrets)
  if (raw !== undefined && raw !== null) {
    return !!raw;
  }
  // Implicit enable if key+index are present
  return !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for Pinecone`);
  return v;
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = requireEnv('PINECONE_API_KEY');
  _client = new Pinecone({ apiKey });
  return _client;
}

function getIndex() {
  const indexName = requireEnv('PINECONE_INDEX');
  const host = process.env.PINECONE_HOST || null; // optional (serverless)
  const client = getClient();
  return host ? client.index(indexName, host) : client.index(indexName);
}

function resolveNamespace({ tenantId, projectId }) {
  const tpl = process.env.PINECONE_NAMESPACE_TEMPLATE;
  const fixed = process.env.PINECONE_NAMESPACE;
  const sanitizePart = (value, { maxLen = 80 } = {}) => {
    const raw = String(value ?? '').trim();
    if (!raw) return 'unknown';
    // NFKD: split accents, then remove diacritics
    const folded = raw
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
    // Allow only safe ASCII for Pinecone namespaces; collapse others to "_"
    const ascii = folded
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/[^A-Za-z0-9._:-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const trimmed = ascii.slice(0, maxLen);
    if (trimmed) return trimmed;
    // Fallback: deterministic short hash (still ASCII)
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, Math.min(40, maxLen));
  };

  if (fixed) return String(fixed);
  if (tpl) {
    return String(tpl)
      .replace(/\{tenantId\}/g, sanitizePart(tenantId, { maxLen: 64 }))
      .replace(/\{projectId\}/g, sanitizePart(projectId, { maxLen: 80 }));
  }
  // Default: isolate by tenant+project (datasetVersion is enforced via metadata filter)
  return `t:${sanitizePart(tenantId, { maxLen: 64 })}:p:${sanitizePart(projectId, { maxLen: 80 })}`;
}

async function upsertVectors({ namespace, vectors }) {
  if (!vectors?.length) return;
  const index = getIndex();
  const ns = namespace || '';
  const batchSize = Math.max(1, Math.min(Number(process.env.PINECONE_UPSERT_BATCH || 100), 500));
  if (pineconeDebugEnabled()) {
    try { logger.info('pinecone.upsert.start', { index: process.env.PINECONE_INDEX, host: process.env.PINECONE_HOST || null, namespace: ns, vectors: vectors.length, batchSize }); } catch { }
  }
  for (let i = 0; i < vectors.length; i += batchSize) {
    const slice = vectors.slice(i, i + batchSize);
    await index.namespace(ns).upsert(slice);
  }
  if (pineconeDebugEnabled()) {
    try { logger.info('pinecone.upsert.done', { namespace: ns, vectors: vectors.length }); } catch { }
  }
}

async function queryVectors({ namespace, vector, topK = 10, filter = null, includeMetadata = true }) {
  const index = getIndex();
  const ns = namespace || '';
  const topKMax = Math.max(1, Math.min(Number(systemSettings.getNumber('PINECONE_QUERY_TOPK_MAX') || 200), 1000));
  const requestedTopK = Number(topK) || 10;
  const effectiveTopK = Math.max(1, Math.min(requestedTopK, topKMax));
  if (pineconeDebugEnabled()) {
    try {
      logger.info('pinecone.query', { index: process.env.PINECONE_INDEX, host: process.env.PINECONE_HOST || null, namespace: ns, topK: effectiveTopK, requestedTopK, topKMax, hasFilter: !!filter });
    } catch { }
    if (requestedTopK !== effectiveTopK) {
      try { logger.info('pinecone.query.clamped', { namespace: ns, requestedTopK, effectiveTopK, topKMax }); } catch { }
    }
  }
  const r = await index.namespace(ns).query({
    vector,
    topK: effectiveTopK,
    filter: filter || undefined,
    includeMetadata: !!includeMetadata,
  });
  return r?.matches || [];
}

async function deleteByFilter({ namespace, filter, bestEffort = false }) {
  try {
    const index = getIndex();
    const ns = namespace || '';
    await index.namespace(ns).deleteMany({ filter });
    return { ok: true };
  } catch (e) {
    if (bestEffort) {
      try { console.warn('[pinecone] deleteByFilter failed (bestEffort)', e?.message || e); } catch {}
      return { ok: false, error: e?.message || String(e) };
    }
    throw e;
  }
}

module.exports = {
  isPineconeEnabled,
  resolveNamespace,
  upsertVectors,
  queryVectors,
  deleteByFilter,
};
