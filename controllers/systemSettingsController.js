const systemSettingsStore = require('../services/systemSettingsStore');
const { getDefinition } = require('../config/systemSettingsRegistry');
const axios = require('axios');
const mailService = require('../services/mailService');
const mailTemplates = require('../services/mailTemplates');
const automatedEmailService = require('../services/automatedEmailService');
const { getMaintenanceStatus } = require('../middlewares/maintenanceModeMiddleware');

let modelsCache = {
  chat: { ts: 0, items: [], recommended: [] },
  all: { ts: 0, items: [], recommended: [] },
};

const getMaintenanceStatusPublic = (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json(getMaintenanceStatus());
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

const getSystemSettings = async (req, res) => {
  try {
    return res.json({
      items: systemSettingsStore.getAllEffective(),
      notices: [],
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
    return res.json({ items: systemSettingsStore.getAllEffective(), notices: [] });
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

const EXTRA_TEST_EMAILS = [
  { key: 'contribution_halfway', label: 'Contribution reward — halfway' },
  { key: 'contribution_reward_earned', label: 'Contribution reward — earned' },
  { key: 'contribution_reward_reminder', label: 'Contribution reward — 10-day reminder' },
  { key: 'contribution_reward_expiry', label: 'Contribution reward — expiry reminder' },
];

function getAutomatedEmailTestCatalog(_req, res) {
  return res.json({
    items: [...automatedEmailService.getLifecycleEmailCatalog(), ...EXTRA_TEST_EMAILS],
  });
}

function renderContributionTestEmail(type) {
  const configuredStep = Number(systemSettingsStore.getNumber('CONTRIBUTION_REWARD_STEP'));
  const milestone = Number.isInteger(configuredStep) && configuredStep > 0 ? configuredStep : 20;
  const configuredTtl = Number(systemSettingsStore.getNumber('CONTRIBUTION_REWARD_PROMO_TTL_DAYS'));
  const ttlDays = Number.isInteger(configuredTtl) && configuredTtl > 0 ? configuredTtl : 30;
  const common = {
    firstName: 'Test',
    milestone,
    code: `THANKS-TEAM-${milestone}-TESTCODE`,
    expiresAt: new Date(Date.now() + ttlDays * 86400000),
    redeemUrl: 'https://certs.atexdb.eu/account?upgrade=team',
  };
  if (type === 'contribution_halfway') {
    return {
      subject: '[TEST] You’re halfway to your free Team month',
      html: mailTemplates.contributionHalfwayEmail({
        firstName: 'Test',
        currentCount: Math.ceil(milestone / 2),
        milestone,
      }, 'ATEXdb'),
    };
  }
  if (type === 'contribution_reward_earned') {
    return {
      subject: '[TEST] Thank you — your 100% Team discount code',
      html: mailTemplates.contributionRewardEmail({
        ...common,
        lastName: 'User',
        copyUrl: 'https://certs.atexdb.eu',
        accountUrl: 'https://certs.atexdb.eu/account',
      }, 'ATEXdb'),
    };
  }
  if (type === 'contribution_reward_reminder' || type === 'contribution_reward_expiry') {
    const finalReminder = type === 'contribution_reward_expiry';
    return {
      subject: finalReminder ? '[TEST] Your free Team month expires soon' : '[TEST] Your free Team month is waiting',
      html: mailTemplates.contributionRewardReminderEmail({ ...common, finalReminder }, 'ATEXdb'),
    };
  }
  return null;
}

async function sendAutomatedEmailTests(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const selected = Array.isArray(req.body?.types)
      ? [...new Set(req.body.types.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    const allowed = new Set([
      ...automatedEmailService.getLifecycleEmailCatalog().map((item) => item.key),
      ...EXTRA_TEST_EMAILS.map((item) => item.key),
    ]);
    const unknown = selected.filter((type) => !allowed.has(type));
    if (!selected.length) return res.status(400).json({ error: 'Select at least one email template.' });
    if (unknown.length) return res.status(400).json({ error: 'Unknown email template(s).', unknown });

    const results = [];
    for (const type of selected) {
      const rendered =
        automatedEmailService.renderLifecycleTestEmail(type) ||
        renderContributionTestEmail(type);
      try {
        await mailService.sendMail({ to: email, subject: rendered.subject, html: rendered.html });
        results.push({ type, ok: true });
      } catch (error) {
        results.push({ type, ok: false, error: error?.message || String(error) });
      }
    }
    const sent = results.filter((result) => result.ok).length;
    return res.status(sent === results.length ? 200 : 207).json({
      ok: sent === results.length,
      email,
      sent,
      failed: results.length - sent,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send test emails.' });
  }
}

module.exports = {
  getMaintenanceStatusPublic,
  getSystemSettings,
  updateSystemSettings,
  resetSystemSettingsToDefault,
  getAutomatedEmailTestCatalog,
  sendAutomatedEmailTests,
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
