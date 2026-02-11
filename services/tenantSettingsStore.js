const mongoose = require('mongoose');
const TenantSetting = require('../models/tenantSetting');
const { getDefinition, getAllDefinitions } = require('../config/tenantSettingsRegistry');

function parseBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseString(value, fallback) {
  if (value == null) return fallback;
  return String(value);
}

function clamp(n, min, max) {
  if (typeof min === 'number' && Number.isFinite(min)) n = Math.max(min, n);
  if (typeof max === 'number' && Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

function normalizeToType(def, value) {
  if (!def) return value;
  if (value === undefined) return undefined;
  if (value === null) return null;

  let v = value;
  switch (def.type) {
    case 'boolean':
      v = parseBoolean(value, def.defaultValue);
      break;
    case 'number':
      v = parseNumber(value, def.defaultValue);
      if (typeof v === 'number' && Number.isFinite(v) && def.constraints) {
        v = clamp(v, def.constraints.min, def.constraints.max);
      }
      break;
    case 'string':
    default:
      v = parseString(value, def.defaultValue);
      break;
  }

  // Enum constraint validation / normalization (string enums + null)
  if (def.constraints && Array.isArray(def.constraints.enum)) {
    if (!def.constraints.enum.includes(v)) {
      // keep as default to avoid breaking prod, but don't throw inside normalization
      return def.defaultValue;
    }
  }

  return v;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // tenantId -> { loadedAt, overrides: Map(key->value), inFlight?: Promise<void> }

async function _loadTenantOverrides(tenantId) {
  if (!isDbReady()) return;
  const docs = await TenantSetting.find({ tenantId: String(tenantId) }).select('key value').lean();
  const overrides = new Map();
  for (const doc of docs) {
    if (!doc?.key) continue;
    overrides.set(String(doc.key), doc.value);
  }
  cache.set(String(tenantId), { loadedAt: Date.now(), overrides });
}

async function _ensureLoaded(tenantId) {
  const t = String(tenantId || '').trim();
  if (!t) return { loadedAt: 0, overrides: new Map() };

  const existing = cache.get(t);
  const stale = !existing || !existing.loadedAt || (Date.now() - existing.loadedAt) > CACHE_TTL_MS;
  if (!stale) return existing;

  if (existing?.inFlight) {
    await existing.inFlight;
    return cache.get(t) || existing;
  }

  const inFlight = (async () => {
    try {
      await _loadTenantOverrides(t);
    } catch {
      // best-effort: keep old cache on transient failure
      if (!cache.has(t) && existing) cache.set(t, existing);
    } finally {
      const cur = cache.get(t);
      if (cur && cur.inFlight) {
        cur.inFlight = null;
      }
    }
  })();

  cache.set(t, { loadedAt: existing?.loadedAt || 0, overrides: existing?.overrides || new Map(), inFlight });
  await inFlight;
  return cache.get(t) || { loadedAt: 0, overrides: new Map() };
}

async function getEffectiveValue(tenantId, key) {
  const def = getDefinition(key);
  if (!def) return undefined;
  const entry = await _ensureLoaded(tenantId);
  const raw = entry.overrides.has(def.key) ? entry.overrides.get(def.key) : def.defaultValue;
  return normalizeToType(def, raw);
}

async function getAllEffective(tenantId) {
  const entry = await _ensureLoaded(tenantId);
  return getAllDefinitions().map((def) => {
    const overridden = entry.overrides.has(def.key);
    const raw = overridden ? entry.overrides.get(def.key) : def.defaultValue;
    const value = normalizeToType(def, raw);
    return {
      key: def.key,
      group: def.group,
      type: def.type,
      description: def.description,
      defaultValue: def.defaultValue,
      value,
      overridden,
    };
  });
}

async function setMany(tenantId, valuesByKey, { updatedBy = null } = {}) {
  const t = String(tenantId || '').trim();
  if (!t) {
    const err = new Error('Missing tenantId');
    err.code = 'MISSING_TENANT';
    throw err;
  }

  const entries = Object.entries(valuesByKey || {});
  const updates = [];
  const toCache = [];

  for (const [key, value] of entries) {
    const def = getDefinition(key);
    if (!def) continue;
    const normalized = normalizeToType(def, value);
    updates.push({
      updateOne: {
        filter: { tenantId: t, key: def.key },
        update: { $set: { tenantId: t, key: def.key, value: normalized, updatedBy: updatedBy ? String(updatedBy) : null } },
        upsert: true,
      },
    });
    toCache.push([def.key, normalized]);
  }

  if (!updates.length) return;
  if (!isDbReady()) {
    const err = new Error('DB not connected');
    err.code = 'DB_NOT_READY';
    throw err;
  }

  await TenantSetting.bulkWrite(updates, { ordered: false });

  const entry = await _ensureLoaded(t);
  for (const [k, v] of toCache) entry.overrides.set(k, v);
  entry.loadedAt = Date.now();
  cache.set(t, entry);
}

async function resetToDefault(tenantId, keys, { updatedBy = null } = {}) {
  const t = String(tenantId || '').trim();
  if (!t) {
    const err = new Error('Missing tenantId');
    err.code = 'MISSING_TENANT';
    throw err;
  }

  const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
  const knownKeys = getAllDefinitions().map((d) => d.key);
  const targetKeys = list.length ? list.filter((k) => knownKeys.includes(k)) : knownKeys;

  if (!isDbReady()) {
    const err = new Error('DB not connected');
    err.code = 'DB_NOT_READY';
    throw err;
  }

  await TenantSetting.deleteMany({ tenantId: t, key: { $in: targetKeys } });

  const entry = await _ensureLoaded(t);
  for (const k of targetKeys) entry.overrides.delete(k);
  entry.loadedAt = Date.now();
  cache.set(t, entry);
}

async function getChatTuning(tenantId) {
  const temperature = await getEffectiveValue(tenantId, 'CHAT_TEMPERATURE');
  const topP = await getEffectiveValue(tenantId, 'CHAT_TOP_P');
  const maxOutputTokens = await getEffectiveValue(tenantId, 'CHAT_MAX_OUTPUT_TOKENS');
  const truncation = await getEffectiveValue(tenantId, 'CHAT_TRUNCATION');
  const reasoningEffort = await getEffectiveValue(tenantId, 'CHAT_REASONING_EFFORT');

  return {
    temperature: typeof temperature === 'number' ? temperature : null,
    topP: typeof topP === 'number' ? topP : null,
    maxOutputTokens: typeof maxOutputTokens === 'number' ? Math.trunc(maxOutputTokens) : null,
    truncation: typeof truncation === 'string' ? truncation : null,
    reasoningEffort: typeof reasoningEffort === 'string' ? reasoningEffort : null,
  };
}

async function getTenantAiProfile(tenantId) {
  const model = await getEffectiveValue(tenantId, 'AI_MODEL');
  const instructions = await getEffectiveValue(tenantId, 'AI_INSTRUCTIONS');
  const kbVectorStoreId = await getEffectiveValue(tenantId, 'KB_VECTOR_STORE_ID');

  return {
    model: typeof model === 'string' ? model : 'gpt-4o-mini',
    instructions: typeof instructions === 'string' ? instructions : '',
    kbVectorStoreId: typeof kbVectorStoreId === 'string' ? kbVectorStoreId : (kbVectorStoreId === null ? null : null),
  };
}

async function getCertificateExtractConfig(tenantId) {
  const model = await getEffectiveValue(tenantId, 'CERT_EXTRACT_MODEL');
  const extraInstructions = await getEffectiveValue(tenantId, 'CERT_EXTRACT_INSTRUCTIONS');
  return {
    model: typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5-mini',
    // NOTE: keep extractor prompts isolated from chat persona (AI_INSTRUCTIONS)
    extraInstructions: typeof extraInstructions === 'string' ? extraInstructions : '',
  };
}

async function getDataplateExtractConfig(tenantId) {
  const model = await getEffectiveValue(tenantId, 'DATAPLATE_EXTRACT_MODEL');
  const extraInstructions = await getEffectiveValue(tenantId, 'DATAPLATE_EXTRACT_INSTRUCTIONS');
  return {
    model: typeof model === 'string' && model.trim() ? model.trim() : 'gpt-4o-mini',
    // NOTE: keep extractor prompts isolated from chat persona (AI_INSTRUCTIONS)
    extraInstructions: typeof extraInstructions === 'string' ? extraInstructions : '',
  };
}

module.exports = {
  getEffectiveValue,
  getAllEffective,
  setMany,
  resetToDefault,
  getChatTuning,
  getTenantAiProfile,
  getCertificateExtractConfig,
  getDataplateExtractConfig,
  _debug: () => ({ size: cache.size }),
};
