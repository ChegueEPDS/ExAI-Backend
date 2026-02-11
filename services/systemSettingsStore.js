const mongoose = require('mongoose');
const SystemSetting = require('../models/systemSetting');
const { getDefinition, getAllDefinitions } = require('../config/systemSettingsRegistry');

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

function normalizeToType(def, value) {
  if (!def) return value;
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (def.type) {
    case 'boolean':
      return parseBoolean(value, def.defaultValue);
    case 'number':
      return parseNumber(value, def.defaultValue);
    case 'string':
    default:
      return parseString(value, def.defaultValue);
  }
}

// In-memory overrides loaded from DB (and updated on writes).
const overrides = new Map(); // key -> value
let started = false;
let reloadTimer = null;
let lastLoadedAt = null;

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function reloadFromDb() {
  if (!isDbReady()) return;
  const docs = await SystemSetting.find({}).select('key value').lean();
  overrides.clear();
  for (const doc of docs) {
    if (!doc || !doc.key) continue;
    overrides.set(String(doc.key), doc.value);
  }
  lastLoadedAt = new Date();
}

function start({ reloadIntervalMs = 60_000 } = {}) {
  if (started) return;
  started = true;

  const tryLoad = async () => {
    try {
      await reloadFromDb();
    } catch (e) {
      // Best-effort: do not crash the app if DB is temporarily unavailable
      // eslint-disable-next-line no-console
      console.warn('[SystemSettings] reloadFromDb failed:', e?.message || e);
    }
  };

  // Load once DB is connected
  if (isDbReady()) {
    void tryLoad();
  } else {
    mongoose.connection.once('connected', () => void tryLoad());
    mongoose.connection.once('open', () => void tryLoad());
  }

  if (reloadIntervalMs > 0) {
    reloadTimer = setInterval(() => void tryLoad(), reloadIntervalMs);
    if (typeof reloadTimer.unref === 'function') reloadTimer.unref();
  }
}

function getEffectiveValue(key) {
  const def = getDefinition(key);
  if (!def) return undefined;
  const raw = overrides.has(key) ? overrides.get(key) : def.defaultValue;
  return normalizeToType(def, raw);
}

function getString(key) {
  const def = getDefinition(key);
  if (!def) return undefined;
  const v = getEffectiveValue(key);
  return v == null ? '' : String(v);
}

function getNumber(key) {
  const def = getDefinition(key);
  if (!def) return undefined;
  const v = getEffectiveValue(key);
  return typeof v === 'number' ? v : parseNumber(v, def.defaultValue);
}

function getBoolean(key) {
  const def = getDefinition(key);
  if (!def) return undefined;
  const v = getEffectiveValue(key);
  return parseBoolean(v, def.defaultValue);
}

function getAllEffective() {
  return getAllDefinitions().map((def) => {
    const overridden = overrides.has(def.key);
    const value = getEffectiveValue(def.key);
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

async function setMany(valuesByKey, { updatedBy = null } = {}) {
  const entries = Object.entries(valuesByKey || {});
  const updates = [];

  for (const [key, value] of entries) {
    const def = getDefinition(key);
    if (!def) continue;
    const normalized = normalizeToType(def, value);
    overrides.set(key, normalized);
    updates.push({
      updateOne: {
        filter: { key },
        update: { $set: { key, value: normalized, updatedBy: updatedBy ? String(updatedBy) : null } },
        upsert: true,
      },
    });
  }

  if (!updates.length) return;
  if (!isDbReady()) {
    const err = new Error('DB not connected');
    err.code = 'DB_NOT_READY';
    throw err;
  }

  await SystemSetting.bulkWrite(updates, { ordered: false });
  lastLoadedAt = new Date();
}

async function resetToDefault(keys, { updatedBy = null } = {}) {
  const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
  const targetKeys = list.length ? list : getAllDefinitions().map((d) => d.key);

  for (const key of targetKeys) overrides.delete(key);

  if (!isDbReady()) {
    const err = new Error('DB not connected');
    err.code = 'DB_NOT_READY';
    throw err;
  }

  await SystemSetting.deleteMany({ key: { $in: targetKeys } });
  // keep lastLoadedAt; effective values now come from defaults
  lastLoadedAt = new Date();
}

// Test helper: do not persist, only override in-memory
function _setInMemoryForTests(valuesByKey) {
  for (const [key, value] of Object.entries(valuesByKey || {})) {
    const def = getDefinition(key);
    if (!def) continue;
    overrides.set(key, normalizeToType(def, value));
  }
}

function _resetInMemoryForTests() {
  overrides.clear();
}

module.exports = {
  start,
  reloadFromDb,
  getEffectiveValue,
  getString,
  getNumber,
  getBoolean,
  getAllEffective,
  setMany,
  resetToDefault,
  // tests
  _setInMemoryForTests,
  _resetInMemoryForTests,
  _debug: () => ({ started, lastLoadedAt, size: overrides.size }),
};

