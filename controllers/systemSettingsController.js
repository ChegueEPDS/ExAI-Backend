const systemSettingsStore = require('../services/systemSettingsStore');
const { getDefinition } = require('../config/systemSettingsRegistry');
const axios = require('axios');
const Standard = require('../models/standard');
const DatasetFile = require('../models/datasetFile');

let modelsCache = {
  chat: { ts: 0, items: [], recommended: [] },
  all: { ts: 0, items: [], recommended: [] },
};

function buildRecommendedModels() {
  // Keep this small and stable; UI will also show "Available" models from /v1/models.
  return [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    'o3-mini',
    'gpt-5-mini',
    'gpt-5',
  ];
}

function looksLikeChatModel(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!s) return false;
  // Exclude clearly non-chat model families to reduce accidental breakage.
  const banned = ['embedding', 'whisper', 'moderation', 'dall-e', 'image', 'realtime', 'tts', 'transcribe', 'audio'];
  if (banned.some((b) => s.includes(b))) return false;
  // Include common chat model prefixes.
  return s.startsWith('gpt-') || /^o\d/.test(s) || s.startsWith('chatgpt-');
}

function collectUnknownKeys(valuesByKey) {
  const unknown = [];
  for (const key of Object.keys(valuesByKey || {})) {
    if (!getDefinition(key)) unknown.push(key);
  }
  return unknown;
}

async function computeEmbeddingReindexNotices() {
  try {
    const enabled = !!systemSettingsStore.getBoolean('EMBEDDING_CONTEXT_HEADER_ENABLED');
    const version = Math.max(1, Number(systemSettingsStore.getNumber('EMBEDDING_CONTEXT_HEADER_VERSION') || 1));
    if (!enabled) return [];

    const [outdatedStandards, outdatedFiles] = await Promise.all([
      Standard.countDocuments({
        status: 'ready',
        $or: [
          { 'meta.embeddingFormatVersion': { $exists: false } },
          { 'meta.embeddingFormatVersion': { $ne: version } },
        ],
      }),
      DatasetFile.countDocuments({
        indexingStatus: 'done',
        approvalStatus: { $ne: 'rejected' },
        $or: [
          { 'meta.embeddingFormatVersion': { $exists: false } },
          { 'meta.embeddingFormatVersion': { $ne: version } },
        ],
      }),
    ]);

    if (!outdatedStandards && !outdatedFiles) return [];

    return [
      {
        level: 'warn',
        code: 'REINDEX_REQUIRED',
        message:
          `Embedding context header is enabled (v${version}), but some items are still indexed with the previous format. ` +
          `Reindex recommended: standards=${outdatedStandards}, datasetFiles=${outdatedFiles}.`,
      },
    ];
  } catch {
    return [];
  }
}

const getSystemSettings = async (req, res) => {
  try {
    return res.json({
      items: systemSettingsStore.getAllEffective(),
      notices: await computeEmbeddingReindexNotices(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to get system settings' });
  }
};

const updateSystemSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const valuesByKey =
      body.values && typeof body.values === 'object'
        ? body.values
        : body.key
          ? { [body.key]: body.value }
          : null;

    if (!valuesByKey) {
      return res.status(400).json({ error: 'Missing payload: expected {values:{...}} or {key,value}' });
    }

    const unknown = collectUnknownKeys(valuesByKey);
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown setting key(s)', unknownKeys: unknown });
    }

    await systemSettingsStore.setMany(valuesByKey, { updatedBy: req.user?.id || req.userId || null });
    return res.json({ items: systemSettingsStore.getAllEffective(), notices: await computeEmbeddingReindexNotices() });
  } catch (e) {
    const code = e?.code || null;
    if (code === 'DB_NOT_READY') return res.status(503).json({ error: 'Database not connected yet' });
    return res.status(500).json({ error: e?.message || 'Failed to update system settings' });
  }
};

const resetSystemSettingsToDefault = async (req, res) => {
  try {
    const body = req.body || {};
    const keys = body.keys || body.key || null;
    if (Array.isArray(keys)) {
      const unknown = keys.filter((k) => !getDefinition(k));
      if (unknown.length) return res.status(400).json({ error: 'Unknown setting key(s)', unknownKeys: unknown });
    } else if (typeof keys === 'string') {
      if (!getDefinition(keys)) return res.status(400).json({ error: 'Unknown setting key(s)', unknownKeys: [keys] });
    }

    await systemSettingsStore.resetToDefault(keys, { updatedBy: req.user?.id || req.userId || null });
    return res.json({ items: systemSettingsStore.getAllEffective(), notices: await computeEmbeddingReindexNotices() });
  } catch (e) {
    const code = e?.code || null;
    if (code === 'DB_NOT_READY') return res.status(503).json({ error: 'Database not connected yet' });
    return res.status(500).json({ error: e?.message || 'Failed to reset system settings' });
  }
};

module.exports = {
  getSystemSettings,
  updateSystemSettings,
  resetSystemSettingsToDefault,
  listOpenAiModels: async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY is not set' });

      const mode = String(req.query?.mode || 'chat').trim().toLowerCase();
      const cacheKey = mode === 'all' ? 'all' : 'chat';
      const ttlMs = 5 * 60 * 1000;
      const now = Date.now();

      const cached = modelsCache[cacheKey];
      if (cached && cached.ts && (now - cached.ts) < ttlMs && Array.isArray(cached.items) && cached.items.length) {
        return res.json({
          ok: true,
          mode: cacheKey,
          cached: true,
          fetchedAt: new Date(cached.ts).toISOString(),
          recommended: cached.recommended || [],
          items: cached.items,
        });
      }

      const resp = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 12_000,
      });
      const data = resp?.data?.data;
      const rawItems = Array.isArray(data) ? data : [];
      let ids = rawItems.map((m) => String(m?.id || '').trim()).filter(Boolean);
      if (cacheKey === 'chat') ids = ids.filter(looksLikeChatModel);
      ids.sort((a, b) => a.localeCompare(b));

      const recommended = buildRecommendedModels();
      modelsCache[cacheKey] = { ts: now, items: ids, recommended };

      return res.json({
        ok: true,
        mode: cacheKey,
        cached: false,
        fetchedAt: new Date(now).toISOString(),
        recommended,
        items: ids,
      });
    } catch (e) {
      const recommended = buildRecommendedModels();
      return res.status(502).json({
        ok: false,
        error: e?.message || 'Failed to list OpenAI models',
        recommended,
        items: [],
      });
    }
  },
};
