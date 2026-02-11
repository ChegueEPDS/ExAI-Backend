const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

function rerankEnabled() {
  return systemSettings.getBoolean('RERANK_ENABLED');
}

function rerankModelForKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'standard_clause') {
    return (
      systemSettings.getString('RERANK_MODEL_STANDARD_CLAUSE') ||
      systemSettings.getString('RERANK_MODEL') ||
      systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL')
    );
  }
  return systemSettings.getString('RERANK_MODEL') || systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL');
}

function rerankMaxItemsForKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  const raw =
    k === 'standard_clause'
      ? systemSettings.getNumber('RERANK_MAX_ITEMS_STANDARD_CLAUSE')
      : systemSettings.getNumber('RERANK_MAX_ITEMS');
  return Math.max(5, Math.min(Number(raw || 40), 80));
}

async function rerankWithLLM({ query, kind = '', items, trace = null, model: modelOverride = null, maxItems: maxItemsOverride = null }) {
  if (!rerankEnabled()) return { ok: true, skipped: true, order: (items || []).map(i => i.id) };
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: true, order: [] };

  const maxItems = Math.max(5, Math.min(Number(maxItemsOverride || rerankMaxItemsForKind(kind)), 80));
  const compact = list.slice(0, maxItems).map((it) => ({
    id: String(it?.id || '').trim(),
    kind: String(it?.kind || '').trim(),
    title: String(it?.title || '').trim(),
    loc: String(it?.loc || '').trim(),
    text: String(it?.text || '').slice(0, 1200),
  })).filter(x => x.id && x.text);

  if (!compact.length) return { ok: true, order: [] };

  const model = String(modelOverride || rerankModelForKind(kind)).trim() || 'gpt-5-mini';

  const system = [
    'You are a reranking component for an engineering compliance RAG system.',
    'Given a query and candidate snippets, return the best ordering by relevance.',
    'Return STRICT JSON only. No extra text.',
    'If uncertain, keep the original ordering.'
  ].join(' ');

  const user = [
    `QUERY:\n${String(query || '').slice(0, 2000)}`,
    '',
    'CANDIDATES_JSON:',
    JSON.stringify(compact).slice(0, 120000),
    '',
    'Return JSON schema:',
    '{ "order": string[], "notes": string }',
    'The "order" must contain the same ids as input (each at most once).'
  ].join('\n');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      order: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['order', 'notes'],
  };

  const respObj = await createResponse({
    model,
    instructions: system,
    input: [{ role: 'user', content: user }],
    store: false,
    temperature: 0,
    maxOutputTokens: 600,
    textFormat: { type: 'json_schema', name: 'rerank_order', strict: true, schema },
    timeoutMs: 60_000,
  });

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  const order = Array.isArray(parsed?.order) ? parsed.order.map(x => String(x || '').trim()).filter(Boolean) : [];

  const ids = new Set(compact.map(x => x.id));
  const uniq = [];
  const seen = new Set();
  for (const id of order) {
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  // Append any missing ids in original order.
  for (const x of compact) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    uniq.push(x.id);
  }

  try {
    logger.info('rerank.done', {
      requestId: trace?.requestId,
      model,
      items: compact.length,
      notes: String(parsed?.notes || '').slice(0, 200),
    });
  } catch { }
  return { ok: true, order: uniq };
}

module.exports = {
  rerankWithLLM,
  rerankEnabled,
};
