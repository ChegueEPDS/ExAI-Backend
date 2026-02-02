const OpenAI = require('openai');
const logger = require('../config/logger');

function rerankEnabled() {
  const v = String(process.env.RERANK_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function rerankModel() {
  return process.env.RERANK_MODEL || process.env.FILE_CHAT_COMPLETIONS_MODEL || 'gpt-5-mini';
}

async function rerankWithLLM({ query, items, trace = null }) {
  if (!rerankEnabled()) return { ok: true, skipped: true, order: (items || []).map(i => i.id) };
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: true, order: [] };

  const maxItems = Math.max(5, Math.min(Number(process.env.RERANK_MAX_ITEMS || 40), 80));
  const compact = list.slice(0, maxItems).map((it) => ({
    id: String(it?.id || '').trim(),
    kind: String(it?.kind || '').trim(),
    title: String(it?.title || '').trim(),
    loc: String(it?.loc || '').trim(),
    text: String(it?.text || '').slice(0, 1200),
  })).filter(x => x.id && x.text);

  if (!compact.length) return { ok: true, order: [] };

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = rerankModel();

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

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const txt = String(resp?.choices?.[0]?.message?.content || '').trim();
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

