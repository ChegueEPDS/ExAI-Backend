const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');
const tenantSettingsStore = require('./tenantSettingsStore');

// === ChatGPT-like formatting instructions (Markdown-first) ===
function getStyleInstructions(mode = 'plain') {
  const base = [
    'You are a helpful, precise assistant in the style of ChatGPT.',
    'Use clear, natural language. Prefer **well‑structured Markdown** when it improves readability (headings, short lists, and tables).',
    'Do **not** force a fixed section template; create sections only if they help the reader.',
    'Leverage the ongoing conversation for context and be consistent with prior answers.',
    'Be concise by default; expand with details only when useful.',
    'If you rely on uploaded files or source documents, mention filenames or section titles when that helps attribution.',
    'Avoid speculation: if something is not in the provided context, say so briefly.',
    'If crucial details are missing, ask one concise clarifying question before proceeding.',
    'Tone: professional, friendly, and direct. Avoid filler.',
    'Always respond in the same language as the user\'s latest message. Detect the language automatically. If the message is multilingual or unclear, reply in the language most used by the user and briefly ask for clarification in that language. Do not switch languages unless the user explicitly asks.',
    'When quoting from files, keep the original quote language, but write your commentary in the user\'s language.'
  ].join(' ');

  return base;
}

function detectReportOrTableIntent(userMsg = '') {
  const m = String(userMsg || '').toLowerCase();
  const kws = [
    // generic analysis / table cues
    'kimutatás', 'kimutatas', 'elemzés', 'elemzes', 'összehasonlítás', 'osszehasonlitas',
    'táblázat', 'tablazat', 'riport', 'report', 'summary', 'összefoglaló', 'osszefoglalo',
    'kpi', 'mutató', 'mutato', 'statisztika', 'metrics', 'table', 'matrix', 'lista', 'ranking',
    'top', 'trend', 'pivot', 'dashboard',
    // compliance / standards cues
    'compliance', 'non-compliance', 'noncompliance', 'conformance', 'conformity',
    'standard', 'standards', 'clause', 'clauses', 'requirement', 'requirements',
    'gap', 'gap analysis', 'audit', 'checklist',
    // Hungarian compliance cues
    'megfelelés', 'megfeleles', 'megfelel', 'nem megfelelés', 'nem megfeleles',
    'szabvány', 'szabvany', 'követelmény', 'kovetelmeny', 'eltérés', 'elteres',
    'hiányosság', 'hianyossag', 'eltéréslista', 'osszevetes'
  ];
  return kws.some(k => m.includes(k));
}

function detectComplianceIntent(userMsg = '') {
  const m = String(userMsg || '').toLowerCase();
  const kws = [
    'compliance', 'non-compliance', 'noncompliance', 'conformance', 'conformity',
    'standard', 'standards', 'clause', 'clauses', 'requirement', 'requirements',
    'gap', 'gap analysis', 'audit', 'checklist',
    // Hungarian
    'megfelelés', 'megfeleles', 'megfelel', 'nem megfelelés', 'nem megfeleles',
    'szabvány', 'szabvany', 'követelmény', 'kovetelmeny', 'eltérés', 'elteres',
    'hiányosság', 'hianyossag', 'eltéréslista'
  ];
  return kws.some(k => m.includes(k));
}

function buildTabularHint(userMsg = '') {
  const lines = [
    'Decide whether a compact **Markdown table** would improve clarity for the current request. If so, include one.',
    '- Keep ≤ 10 columns and ≤ 30 rows; if larger, show an aggregated/top view and state the filter.',
    '- Use short column headers and include units; avoid empty columns and do not fabricate data.',
    '- After the table, add 1–2 bullet takeaways.',
    'If the request involves standards, clauses, requirements, conformity, audits, or compliance (in any language), include a table titled "Compliance summary" with columns like: Item/Subject, Requirement/Clause, Evidence (short quote with filename), Status (Compliant/Partial/Non‑compliant/Not found), Notes/Gap. Place this table immediately after a short direct answer.'
  ];
  return lines.join(' ');
}

function stripHtml(input) {
  return String(input || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function buildRollingSummary(conversation) {
  try {
    const last = Array.isArray(conversation?.messages) ? conversation.messages.slice(-12) : [];
    const plain = last.map(m => `${String(m.role || '').toUpperCase()}: ${stripHtml(m.content)}`).join('\n');
    if (!plain) return '';
    const sys = 'Summarize the dialogue for the assistant to use as context. Be concise, neutral, 10–15 sentences. No action items, no fluff. Do not invent facts.';
    const model = systemSettings.getString('SUMMARY_COMPLETIONS_MODEL') || 'gpt-5-mini';
    const respObj = await createResponse({
      model,
      instructions: sys,
      input: [{ role: 'user', content: plain }],
      store: false,
      temperature: 0,
      maxOutputTokens: 700,
      timeoutMs: 60_000,
    });
    return extractOutputTextFromResponse(respObj) || '';
  } catch {
    return '';
  }
}


// Cache tenant AI profile for reuse in streaming runs (no Assistants API dependency).
const tenantAiCache = new Map(); // tenantId -> { ts, value }

async function getTenantAiProfileCached(tenantId) {
  const t = String(tenantId || '').trim();
  if (!t) return { instructions: '', model: null, kbVectorStoreId: null };

  const cached = tenantAiCache.get(t);
  if (cached && (Date.now() - cached.ts) < 30_000) {
    return cached.value || { instructions: '', model: null, kbVectorStoreId: null };
  }

  try {
    const v = await tenantSettingsStore.getTenantAiProfile(t);
    const val = {
      instructions: String(v?.instructions || ''),
      model: v?.model ? String(v.model) : null,
      kbVectorStoreId: v?.kbVectorStoreId ? String(v.kbVectorStoreId) : null,
    };
    tenantAiCache.set(t, { value: val, ts: Date.now() });
    return val;
  } catch {
    const val = { instructions: '', model: null, kbVectorStoreId: null };
    tenantAiCache.set(t, { value: val, ts: Date.now() });
    return val;
  }
}

module.exports = {
  getStyleInstructions,
  detectReportOrTableIntent,
  detectComplianceIntent,
  buildTabularHint,
  stripHtml,
  buildRollingSummary,
  getTenantAiProfileCached,
};
