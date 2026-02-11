const OpenAI = require('openai');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const { get_encoding } = require('tiktoken');
const logger = require('../config/logger');
const { initSse } = require('../services/sseService');
const { notifyAndStore } = require('../lib/notifications/notifier');

const Conversation = require('../models/conversation');
const Dataset = require('../models/dataset');
const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const DatasetTableCell = require('../models/datasetTableCell');
const DatasetDocChunk = require('../models/datasetDocChunk');
const DatasetDerivedMetric = require('../models/datasetDerivedMetric');
const DatasetImageChunk = require('../models/datasetImageChunk');
const pinecone = require('../services/pineconeService');
const StandardSet = require('../models/standardSet');
const StandardClause = require('../models/standardClause');
const { foldForSearch, bestWindowSimilarity, bestFuzzyMatch } = require('../helpers/fuzzyMatch');
const { keywordScore } = require('../helpers/hybridScore');
const { rerankWithLLM } = require('../services/rerankService');
const measEval = require('../services/measurementEvaluatorService');
const xlsxPlanner = require('../services/xlsxPlannerService');
const xlsxPreview = require('../services/xlsxPreviewService');
const systemSettings = require('../services/systemSettingsStore');

const encoder = get_encoding('o200k_base');


async function setConversationJob(conversation, patch) {
  if (!conversation) return;
  const prev = conversation.job || null;
  conversation.job = {
    ...(prev || {}),
    ...(patch || {}),
    updatedAt: new Date(),
    progress: { ...(prev?.progress || {}), ...(patch?.progress || {}) },
    meta: { ...(prev?.meta || {}), ...(patch?.meta || {}) },
    error: patch && Object.prototype.hasOwnProperty.call(patch, 'error') ? patch.error : (prev?.error || undefined),
  };
  conversation.hasBackgroundJob = ['queued', 'running'].includes(String(conversation.job?.status || ''));
  await conversation.save();
}

function cosineSimilarity(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sanitizeEmbeddingInput(s) {
  const v = String(s ?? '').replace(/\u0000/g, '').trim();
  return v.length ? v : '';
}

function validateStructuredOutputsJsonSchema(schema) {
  const issues = [];

  function walk(node, path) {
    if (!node || typeof node !== 'object') return;

    if (Object.prototype.hasOwnProperty.call(node, 'oneOf')) {
      issues.push(`${path}: oneOf is not permitted (use anyOf)`);
    }

    const type = node.type;
    if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
      const props = node.properties && typeof node.properties === 'object' ? node.properties : null;
      if (props) {
        if (node.additionalProperties !== false) {
          issues.push(`${path}: additionalProperties must be false`);
        }
        const keys = Object.keys(props);
        const req = Array.isArray(node.required) ? node.required : null;
        if (!req) {
          issues.push(`${path}: required must be supplied and include all keys in properties`);
        } else {
          for (const k of keys) {
            if (!req.includes(k)) issues.push(`${path}: required missing "${k}"`);
          }
        }
        for (const [k, v] of Object.entries(props)) walk(v, `${path}.properties.${k}`);
      }
    }

    if (node.items) walk(node.items, `${path}.items`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((x, i) => walk(x, `${path}.anyOf[${i}]`));
    if (Array.isArray(node.allOf)) node.allOf.forEach((x, i) => walk(x, `${path}.allOf[${i}]`));
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((x, i) => walk(x, `${path}.oneOf[${i}]`));
  }

  walk(schema, '$');
  return issues;
}

function tokenTrim(str, maxTokens) {
  const ids = encoder.encode(String(str || ''));
  if (ids.length <= maxTokens) return String(str || '');
  return encoder.decode(ids.slice(0, maxTokens));
}

async function createEmbeddingVector(openaiClient, text, embeddingModel) {
  const input0 = sanitizeEmbeddingInput(text);
  const input = sanitizeEmbeddingInput(tokenTrim(input0, 800));
  if (!input) return [];
  const resp = await openaiClient.embeddings.create({ model: embeddingModel, input: [input] });
  return resp.data?.[0]?.embedding || [];
}

function extractNumericLiterals(text) {
  const s = String(text || '');
  const hits = s.match(/[-+]?\d[\d\s.,]*\d|[-+]?\d/g);
  return (hits || []).map(x => String(x).trim()).filter(Boolean);
}

function parseNumberLoose(input) {
  const s0 = String(input ?? '').trim();
  if (!s0) return null;
  const s = s0
    .replace(/\s/g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.+\-eE]/g, '');
  if (!s || s === '.' || s === '-' || s === '+') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractAnswerNumericKeys(answerText) {
  const s = String(answerText || '').replace(/\r/g, '');
  const lines = s.split('\n');
  const keys = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Ignore markdown ordered list markers like "1. " or "2) "
    const line = lines[i].replace(/^\s*\d+\s*[.)]\s+/, '');
    const lits = extractNumericLiterals(line);
    for (const lit of lits) {
      const n = parseNumberLoose(lit);
      if (Number.isFinite(n)) keys.push(numKey(n));
    }
  }
  return keys;
}

function annotateUncoveredNumbers(answerText, uncoveredKeys) {
  const s = String(answerText || '');
  const set = new Set(Array.isArray(uncoveredKeys) ? uncoveredKeys : []);
  if (!set.size) return s;

  // Replace numeric literals, but skip ordered list markers at line start.
  return s.replace(/[-+]?\d[\d\s.,]*\d|[-+]?\d/g, (match, _p1, offset) => {
    const before = s.slice(Math.max(0, offset - 6), offset);
    const atLineStart = before.includes('\n') ? /^\n\s*$/.test(before.slice(before.lastIndexOf('\n'))) : /^\s*$/.test(before);
    const after = s.slice(offset + match.length, offset + match.length + 3);
    if (atLineStart && /^[.)]\s/.test(after)) return match; // list marker like "1. "

    const n = parseNumberLoose(match);
    if (!Number.isFinite(n)) return match;
    const k = numKey(n);
    if (!set.has(k)) return match;
    // Add visible marker + CSS-hook (span is allowed with class in sanitizeHtml config)
    return `<span class="num-unverified">${match}</span>`;
  });
}

function numKey(n) {
  if (!Number.isFinite(n)) return '';
  const v = Math.round(n * 1e9) / 1e9;
  return String(v);
}

function collectEvidenceNumberKeysFromQuotes(quotes) {
  const keys = new Set();
  for (const q of Array.isArray(quotes) ? quotes : []) {
    const sourceType = String(q?.sourceType || '').trim().toLowerCase();
    if (sourceType === 'image') continue; // numbers from images are NOT accepted as numeric proof
    const txt = String(q?.quote || q?.text || '');
    for (const lit of extractNumericLiterals(txt)) {
      const n = parseNumberLoose(lit);
      if (Number.isFinite(n)) keys.add(numKey(n));
    }
  }
  return keys;
}

function pickByKey(matches, { maxTotal, perKey, keyFn }) {
  const out = [];
  const counts = new Map();
  const seen = new Set();
  for (const m of matches || []) {
    const id = String(m?.id || '');
    if (!id || seen.has(id)) continue;
    const key = String(keyFn(m) || 'key:unknown');
    const c = counts.get(key) || 0;
    if (perKey && c >= perKey) continue;
    counts.set(key, c + 1);
    out.push(m);
    seen.add(id);
    if (out.length >= maxTotal) break;
  }
  return out;
}

async function validateEvidence({ tenantId, projectId, datasetVersion, evidence }) {
  if (!Array.isArray(evidence)) return false;
  const checks = evidence.slice(0, 200);
  for (const ev of checks) {
    const kind = String(ev?.kind || '').trim().toLowerCase();

    // Computed evidence: must be traceable to source cells and reproducible.
    if (kind === 'computed' || Array.isArray(ev?.sources) || ev?.op) {
      const op = String(ev?.op || '').trim().toLowerCase();
      const sources = Array.isArray(ev?.sources) ? ev.sources : [];
      const valueNumber = parseNumberLoose(ev?.value);
      if (!op || !Number.isFinite(valueNumber) || sources.length < 2 || sources.length > 8) return false;

      const sourceValues = [];
      for (const src of sources) {
        const filename = String(src?.fileName || src?.filename || '').trim();
        const sheet = String(src?.sheet || '').trim();
        const rowIndex = Number(src?.rowIndex ?? src?.row ?? NaN);
        const colIndex = Number(src?.colIndex ?? src?.col ?? NaN);
        const cell = String(src?.cell || '').trim();
        const n = parseNumberLoose(src?.value);
        if (!filename || !Number.isFinite(n)) return false;
        if (!cell && (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex))) return false;

        const found = await DatasetTableCell.exists({
          tenantId,
          projectId,
          datasetVersion,
          filename,
          sheet,
          ...(cell ? { cell } : { rowIndex, colIndex }),
          valueNumber: n,
        });
        if (!found) return false;
        sourceValues.push(n);
      }

      let computed = null;
      if (op === 'delta') computed = sourceValues[0] - sourceValues[1];
      else if (op === 'range') computed = sourceValues[0] - sourceValues[1];
      else if (op === 'sum') computed = sourceValues.reduce((a, b) => a + b, 0);
      else if (op === 'avg') computed = sourceValues.reduce((a, b) => a + b, 0) / sourceValues.length;
      else return false;

      if (!Number.isFinite(computed)) return false;
      const tol = 1e-6;
      if (Math.abs(computed - valueNumber) > tol) return false;
      continue;
    }

    const filename = String(ev?.fileName || ev?.filename || '').trim();
    const sheet = String(ev?.sheet || '').trim();
    const rowIndex = Number(ev?.rowIndex ?? ev?.row ?? NaN);
    const colIndex = Number(ev?.colIndex ?? ev?.col ?? NaN);
    const cell = String(ev?.cell || '').trim();
    const valueNumber = parseNumberLoose(ev?.value);
    if (!filename || !Number.isFinite(valueNumber)) return false;
    if (!cell && (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex))) return false;

    const found = await DatasetTableCell.exists({
      tenantId,
      projectId,
      datasetVersion,
      filename,
      sheet,
      ...(cell ? { cell } : { rowIndex, colIndex }),
      valueNumber,
    });
    if (!found) return false;
  }
  return true;
}

async function validateNumericEvidence({ tenantId, projectId, datasetVersion, numericEvidence }) {
  return validateEvidence({ tenantId, projectId, datasetVersion, evidence: numericEvidence });
}

function finalizeHtml(markdownOrText) {
  const cleaned = String(markdownOrText || '').trim().replace(/【.*?】/g, '');
  const sanitized = sanitizeHtml(cleaned, {
    allowedTags: ['a', 'b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { 'span': ['class'], 'a': ['href', 'title', 'target', 'rel'] },
    transformTags: { 'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true) },
    disallowedTagsMode: 'discard'
  });
  return marked(sanitized);
}

function buildCitationsMarkdown(quotes, lang = 'en') {
  const items = (Array.isArray(quotes) ? quotes : [])
    .map((q) => ({
      fileName: String(q?.fileName || q?.filename || q?.standardId || '').trim(),
      clauseId: String(q?.clauseId || '').trim(),
      pageOrLoc: String(q?.pageOrLoc || q?.loc || q?.page || '').trim(),
      quote: String(q?.quote || q?.text || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((q) => q.fileName && q.quote)
    .slice(0, 12);
  if (!items.length) return '';

  const heading = String(lang).toLowerCase() === 'hu' ? 'Hivatkozások' : 'References';
  const lines = [`\n\n---\n\n### ${heading}`];
  for (const it of items) {
    const parts = [];
    if (it.clauseId) parts.push(`cl.${it.clauseId}`);
    if (it.pageOrLoc) parts.push(it.pageOrLoc);
    const loc = parts.length ? ` (${parts.join(', ')})` : '';
    lines.push(`- **${it.fileName}**${loc}: ${it.quote}`);
  }
  return lines.join('\n');
}

function detectUserModeOverride(msg) {
  const s = String(msg || '').toLowerCase();
  if (s.includes('csak gáz') || s.includes('gas only')) return 'GAS_ONLY';
  if (s.includes('csak por') || s.includes('dust only')) return 'DUST_ONLY';
  if (s.includes('mindkettő') || s.includes('both')) return 'BOTH';
  return null;
}

function detectModeFromEvidence(text) {
  const t = String(text || '');
  const gas =
    /\bEx\s*(d|db|e|eb|p|i|m|mb)\b/i.test(t) ||
    /\b(Ga|Gb|Gc)\b/.test(t) ||
    /\b(1G|2G|3G)\b/i.test(t) ||
    /\b(IIC|IIB|IIA)\b/.test(t) ||
    /\bT[1-6]\b/.test(t);
  const dust =
    /\bEx\s*(t|tb|tc)\b/i.test(t) ||
    /\b(Da|Db|Dc)\b/.test(t) ||
    /\b(1D|2D|3D)\b/i.test(t) ||
    /\b(IIIA|IIIB|IIIC)\b/.test(t) ||
    /\bIP6X\b/i.test(t) ||
    /\bT\d{2,3}\s*°?\s*C\b/i.test(t);
  if (gas && dust) return 'BOTH';
  if (gas) return 'GAS_ONLY';
  if (dust) return 'DUST_ONLY';
  return 'BOTH'; // conservative default
}

function normalizeHint(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsToken(haystack, needle) {
  const h = normalizeHint(haystack);
  const n = normalizeHint(needle);
  if (!h || !n) return false;
  if (n.length <= 3) return h.split(/\s+/).includes(n);
  return h.includes(n);
}

function asNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function hybridScoreValue({ query, text, vectorScore }) {
  const alpha = Math.max(0, Math.min(Number(systemSettings.getNumber('HYBRID_ALPHA') || 0.25), 2));
  const k = keywordScore({ query, text });
  return asNumber(vectorScore) + alpha * k;
}

async function applyRerank({ query, kind, items, trace }) {
  // items: [{ id, kind, title, loc, text, _score }]
  const maxForRerank = (() => {
    const k = String(kind || '').trim().toLowerCase();
    const raw = k === 'standard_clause'
      ? systemSettings.getNumber('RERANK_MAX_ITEMS_STANDARD_CLAUSE')
      : systemSettings.getNumber('RERANK_MAX_ITEMS');
    return Math.max(5, Math.min(Number(raw || 40), 80));
  })();
  const slice = (items || []).slice(0, maxForRerank);
  const r = await rerankWithLLM({
    query,
    kind,
    items: slice.map(x => ({ id: x.id, kind, title: x.title, loc: x.loc, text: x.text })),
    trace,
    model: String(kind || '').trim().toLowerCase() === 'standard_clause'
      ? (systemSettings.getString('RERANK_MODEL_STANDARD_CLAUSE') || null)
      : null,
    maxItems: maxForRerank,
  });
  const order = Array.isArray(r?.order) ? r.order : [];
  if (!order.length) return items || [];
  const byId = new Map((items || []).map(x => [String(x.id), x]));
  const out = [];
  const seen = new Set();
  for (const id of order) {
    const it = byId.get(String(id));
    if (!it || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push(it);
  }
  for (const it of items || []) {
    if (seen.has(String(it.id))) continue;
    seen.add(String(it.id));
    out.push(it);
  }
  return out;
}

function fuzzyContains(message, phrase, { threshold }) {
  const mf = foldForSearch(message);
  const pf = foldForSearch(phrase);
  if (!mf || !pf) return false;
  const sim = bestWindowSimilarity(mf, pf);
  return sim >= threshold;
}

function extractStandardNumberTokens(text) {
  const s = String(text || '');
  const hits = s.match(/\b\d{4,5}\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3})?\b/g) || [];
  return Array.from(new Set(hits.map(x => x.replace(/\s+/g, ''))));
}

function detectLanguage(userMsg = '') {
  const raw = String(userMsg || '');
  const s = raw.toLowerCase();
  // Very lightweight heuristic: Hungarian has frequent accented vowels and function words.
  const hasHuAccents = /[áéíóöőúüű]/i.test(raw);
  const huWords = ['hogy', 'és', 'nem', 'kell', 'szerint', 'mi', 'milyen', 'mennyire', 'megfelel', 'kockázat', 'szabvány', 'tanús', 'törlés', 'kérdés'];
  const huHits = huWords.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0);
  if (hasHuAccents || huHits >= 2) return 'hu';

  // English fallback heuristic
  const enWords = ['the', 'and', 'not', 'must', 'should', 'analysis', 'risk', 'compliance', 'standard', 'compare', 'change'];
  const enHits = enWords.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0);
  if (enHits >= 2) return 'en';

  // Default: prefer Hungarian only when clearly indicated, otherwise English.
  return 'en';
}

function isDefinitionLikeQuestion(message) {
  const s = String(message || '').toLowerCase();
  if (/\b\d+(?:\.\d+){1,5}\b/.test(s)) return true; // clause id like 3.69.4
  const needles = [
    'definition', 'define', 'means', 'what does', 'what is the definition',
    'mit jelent', 'jelentése', 'definíció', 'definicio', 'magyarázd el', 'magyarázat',
  ];
  return needles.some(n => s.includes(n));
}

function numericEvidenceRequired() {
  return systemSettings.getBoolean('GOVERNED_REQUIRE_NUMERIC_EVIDENCE');
}

function detectAnswerMode(message = '') {
  const s = String(message || '').toLowerCase();
  // "Report" mode: user explicitly asks for analysis/report/summary/compliance style output.
  const reportNeedles = [
    'project summary',
    'risk assessment',
    'compliance',
    'compliance matrix',
    'matrix',
    'report',
    'analysis',
    'analyze',
    'evaluate',
    'assessment',
    'összefoglal',
    'projekt összefoglal',
    'kockázat',
    'kockazat',
    'megfelel',
    'megfelelőség',
    'megfeleloseg',
    'compliance',
    'elemzés',
    'elemzes',
    'értékeld',
    'ertekeld',
    'kiértékel',
    'kiertekel',
    'táblázatos',
    'tablazatos',
  ];
  if (reportNeedles.some(n => s.includes(n))) return 'report';

  // Otherwise: conversational follow-up mode (normal chat), still evidence-based.
  return 'chat';
}

function languageLabel(lang) {
  return lang === 'hu' ? 'magyar' : 'english';
}

function quickScoreSet({ set, message, evidenceText }) {
  let score = 0;
  const q = normalizeHint(message);
  const ev = normalizeHint(evidenceText);
  const needles = [set.key, set.name, ...(set.aliases || [])].filter(Boolean);
  for (const n of needles) {
    if (containsToken(q, n)) score += 100;
    else if (containsToken(ev, n)) score += 30;
  }
  // Boost if question mentions one of the standard numbers contained in the set
  const nums = extractStandardNumberTokens(message + '\n' + evidenceText);
  const stds = Array.isArray(set.standardRefs) ? set.standardRefs : [];
  const stdIdJoined = stds.map(s => normalizeHint(s?.standardId || '')).join(' ');
  for (const num of nums) {
    const n = normalizeHint(num);
    if (n && stdIdJoined.includes(n)) score += 80;
  }
  return score;
}

async function selectStandardSetsWithLLM({ openai, sets, message, evidenceMode, evidenceSnippets, language }) {
  const model =
    systemSettings.getString('STANDARD_ROUTER_MODEL') ||
    systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') ||
    'gpt-5-mini';
  const lang = String(language || 'en').toLowerCase() === 'hu' ? 'hu' : 'en';
  const sys = [
    'You are a routing component for an engineering compliance assistant.',
    'Pick which standard sets to use (0..3) based on the user question and evidence hints.',
    `If uncertain, ask ONE clarifying question in the same language as the user question (language=${lang}) and provide 3-6 options (set keys).`,
    'Return STRICT JSON only.'
  ].join(' ');
  const options = sets.slice(0, 12).map(s => ({
    key: s.key,
    name: s.name,
    modeHint: s.modeHint || 'unknown',
    aliases: (s.aliases || []).slice(0, 8),
    standards: (s.standardRefs || []).map(r => ({
      standardId: r.standardId || '',
      edition: r.edition || '',
      name: r.name || ''
    })).slice(0, 12)
  }));
  const user = [
    `EVIDENCE_MODE_HINT: ${evidenceMode}`,
    'STANDARD_SET_OPTIONS:',
    JSON.stringify(options),
    '',
    'EVIDENCE_SNIPPETS:',
    String(evidenceSnippets || '').slice(0, 4000),
    '',
    'QUESTION:',
    String(message || '').slice(0, 2000),
    '',
    'Output JSON schema:',
    '{ "selected_keys": string[], "ask_clarify": boolean, "clarifying_question_hu": string, "confidence": number }'
  ].join('\n');

  const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      selected_keys: { type: 'array', items: { type: 'string' } },
      ask_clarify: { type: 'boolean' },
      clarifying_question_hu: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['selected_keys', 'ask_clarify', 'clarifying_question_hu', 'confidence'],
  };

  const respObj = await createResponse({
    model,
    instructions: sys,
    input: [{ role: 'user', content: user }],
    store: false,
    temperature: 0,
    maxOutputTokens: 700,
    textFormat: { type: 'json_schema', name: 'standard_router', strict: true, schema },
    timeoutMs: 60_000,
  });

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  return parsed;
}

async function resolveStandardSelection({ tenantId, message, evidenceText, openai }) {
  const sets = await StandardSet.find({ tenantId }).populate('standardRefs').lean();
  if (!sets.length) return { selectedSets: [], clarify: null };

  const lang = detectLanguage(message);

  const q = normalizeHint(message);
  const fuzzyEnabled = systemSettings.getBoolean('STANDARD_SET_FUZZY_ENABLED');
  const fuzzyThreshold = Math.max(0.6, Math.min(0.98, Number(systemSettings.getNumber('STANDARD_SET_FUZZY_THRESHOLD') || 0.86)));

  const explicit = sets.filter(s => {
    const keys = [s.key, s.name, ...(s.aliases || [])].filter(Boolean);
    return keys.some(k => containsToken(q, k));
  });
  if (explicit.length) {
    return { selectedSets: explicit.slice(0, 3), clarify: null };
  }

  // Fuzzy: tolerate small typos for set selection (name/key/aliases).
  if (fuzzyEnabled) {
    const candidates = [];
    for (const s of sets) {
      candidates.push({ set: s, label: s.name });
      candidates.push({ set: s, label: s.key });
      for (const a of (s.aliases || [])) candidates.push({ set: s, label: a });
    }
    // Find best match and accept if above threshold
    let best = null;
    const mf = foldForSearch(message);
    if (mf) {
      for (const c of candidates) {
        const pf = foldForSearch(c.label);
        if (!pf) continue;
        const sim = bestWindowSimilarity(mf, pf);
        if (sim < fuzzyThreshold) continue;
        const score = sim * 1000 + Math.min(40, pf.length);
        if (!best || score > best.score) best = { set: c.set, score, sim };
      }
    }
    if (best?.set) return { selectedSets: [best.set].slice(0, 1), clarify: null };
  }

  if (sets.length === 1) return { selectedSets: [sets[0]], clarify: null };

  // Quick score pre-ranking
  const ranked = sets
    .map(s => ({ s, score: quickScoreSet({ set: s, message, evidenceText }) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 6).map(x => x.s);

  const llmEnabled = systemSettings.getBoolean('STANDARD_ROUTER_LLM');
  const evidenceMode = detectModeFromEvidence(`${message}\n\n${evidenceText || ''}`);

  if (llmEnabled && openai) {
    try {
      const r = await selectStandardSetsWithLLM({
        openai,
        sets: top,
        message,
        evidenceMode,
        evidenceSnippets: evidenceText,
        language: lang,
      });
      const keys = Array.isArray(r?.selected_keys) ? r.selected_keys.map(String) : [];
      const ask = !!r?.ask_clarify;
      if (ask) {
        const options = top.map((s, idx) => ({ i: idx + 1, setId: String(s._id), key: s.key, name: s.name, modeHint: s.modeHint || 'unknown' }));
        const fallback = lang === 'hu'
          ? [
            'Melyik szabványcsomagot használjam?',
            'Válaszolj a sorszámmal (pl. 1) vagy a csomag nevével.',
            '',
            ...options.map(o => `${o.i} - ${o.name}`)
          ].join('\n')
          : [
            'Which standard set should I use?',
            'Reply with the number (e.g., 1) or the set name.',
            '',
            ...options.map(o => `${o.i} - ${o.name}`)
          ].join('\n');
        return {
          selectedSets: [],
          clarify: {
            questionHu: String(r?.clarifying_question_hu || '').trim() || fallback,
            options,
          }
        };
      }
      const chosen = top.filter(s => keys.some(k => normalizeHint(k) === normalizeHint(s.key))).slice(0, 3);
      if (chosen.length) return { selectedSets: chosen, clarify: null };
    } catch {
      // fall back below
    }
  }

  // Deterministic fallback: if top score isn't clearly separated, ask once.
  const a = ranked[0];
  const b = ranked[1];
  const options = top.map((s, idx) => ({ i: idx + 1, setId: String(s._id), key: s.key, name: s.name, modeHint: s.modeHint || 'unknown' }));
  if (b && a && a.score > 0 && (a.score - b.score) < 50) {
    const question = lang === 'hu'
      ? [
        'Több releváns szabványcsomag is szóba jöhet. Melyiket használjam?',
        'Válaszolj a sorszámmal (pl. 1) vagy a csomag nevével.',
        '',
        ...options.map(o => `${o.i} - ${o.name}`)
      ].join('\n')
      : [
        'More than one standard set could be relevant. Which one should I use?',
        'Reply with the number (e.g., 1) or the set name.',
        '',
        ...options.map(o => `${o.i} - ${o.name}`)
      ].join('\n');
    return {
      selectedSets: [],
      clarify: {
        questionHu: question,
        options,
      }
    };
  }

  return { selectedSets: [a ? a.s : top[0]].filter(Boolean).slice(0, 1), clarify: null };
}

function parseClarifyNumericSelection(conversation, message) {
  const raw = String(message || '').trim();
  const last = Array.isArray(conversation?.messages) ? conversation.messages.slice().reverse().find(x => x?.role === 'assistant') : null;
  const opts = last?.meta?.options;
  if (!Array.isArray(opts) || !opts.length) return null;

  // 1) Numeric selection ("1", "2", ...)
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    const pick = opts.find(o => Number(o?.i) === n) || opts[n - 1] || null;
    const setId = String(pick?.setId || '').trim();
    return setId || null;
  }

  // 2) "1) name" style selection
  const m = raw.match(/^(\d+)\s*[\)\.\-:]\s*(.+)$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) {
      const pick = opts.find(o => Number(o?.i) === n) || opts[n - 1] || null;
      const setId = String(pick?.setId || '').trim();
      if (setId) return setId;
    }
  }

  // 3) Match by set name/key (case-insensitive)
  const norm = (s) => String(s || '').trim().toLowerCase();
  const want = norm(raw);
  if (!want) return null;
  const pick =
    opts.find(o => norm(o?.name) === want) ||
    opts.find(o => norm(o?.key) === want) ||
    null;
  const setId = String(pick?.setId || '').trim();
  if (setId) return setId;

  // 4) Fuzzy match by name/key (diacritics + small typos)
  const threshold = Math.max(0.6, Math.min(0.98, Number(systemSettings.getNumber('STANDARD_SET_FUZZY_THRESHOLD') || 0.86)));
  const best = bestFuzzyMatch({
    message: raw,
    candidates: opts.flatMap(o => [o?.name, o?.key].filter(Boolean)),
    threshold,
  });
  if (!best) return null;
  const pickedOpt = opts.find(o => String(o?.name || '').trim() === best.raw || String(o?.key || '').trim() === best.raw) || null;
  const sid = String(pickedOpt?.setId || '').trim();
  return sid || null;
}

// POST /api/chat/governed/stream
// body: { threadId, projectId, datasetVersion?, message }
exports.chatGovernedStream = async (req, res) => {
  const send = initSse(req, res, {
      setClosedFlag: 'sseClosed',
      onClose: ({ req }) => {
        try { logger.warn('governed.sse.closed', { requestId: req?.requestId, path: req?.originalUrl }); } catch { }
      }
    });
  try {
    const userId = req.userId;
    const tenantId = req.scope?.tenantId;
    const { threadId, message, standardRef: requestedStandardRef0 } = req.body || {};
    const requestedVersion = req.body?.datasetVersion;

    const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');

    if (!userId || !tenantId) {
      send('error', { message: 'Missing auth/tenant.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!threadId || typeof threadId !== 'string' || !threadId.trim()) {
      send('error', { message: 'threadId is required.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      send('error', { message: 'message is required.' });
      send('done', { ok: false });
      return res.end();
    }

    const lang = detectLanguage(message);
    let answerMode = detectAnswerMode(message);

    try {
      logger.info('governed.start', {
        requestId: req.requestId,
        tenantId: String(tenantId),
        userId: String(userId),
        projectId,
        requestedVersion: requestedVersion === undefined ? null : requestedVersion,
        messageChars: String(message).trim().length,
        pineconeEnabled: pinecone.isPineconeEnabled(),
      });
    } catch { }

    const conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) {
      send('error', { message: 'Conversation not found.' });
      send('done', { ok: false });
      return res.end();
    }

    // --- Standard Explorer mode (tenant standard library, PDF-only) ---
    // If the client pins a standardRef, persist it on the conversation and allow governed chat without project datasets.
    const requestedStandardRef = String(requestedStandardRef0 || '').trim();
    if (requestedStandardRef) {
      try {
        conversation.standardExplorer = { enabled: true, standardRef: requestedStandardRef };
      } catch { }
    }
    const standardExplorerEnabled = !!(conversation?.standardExplorer?.enabled);
    const primaryStandardRef = standardExplorerEnabled
      ? String(conversation?.standardExplorer?.standardRef || '').trim()
      : '';
    // Standard Explorer should behave like the legacy "standard chat": quote + explain, not a project-summary report.
    if (standardExplorerEnabled) {
      answerMode = 'chat';
    }

    // Resolve (or create) an internal projectId for this thread, so the client doesn't need to manage it.
    // This id is used for dataset scoping, blob prefix, and Pinecone namespace.
    let projectId = String(conversation.governedProjectId || '').trim();
    if (!projectId) {
      projectId = `p_${crypto.randomBytes(8).toString('hex')}`;
      conversation.governedProjectId = projectId;
    }
    // Persist that this thread is using governed backend for follow-ups.
    if (conversation.chatBackend !== 'governed') {
      conversation.chatBackend = 'governed';
    }
    if (conversation.isModified()) {
      await conversation.save();
    }

    // Mark conversation as running immediately so the conversation list can show "Running"
    // even if the client navigates away mid-request.
    if (conversation.job && ['queued', 'running'].includes(String(conversation.job.status || ''))) {
      send('error', { message: 'A kérés már feldolgozás alatt van ehhez a beszélgetéshez.' });
      send('done', { ok: false });
      return res.end();
    }
    await setConversationJob(conversation, {
      type: 'governed_chat',
      status: 'running',
      stage: 'init',
      startedAt: new Date(),
      finishedAt: null,
      error: undefined,
      meta: {
        threadId,
        projectId,
        datasetVersion: requestedVersion === undefined ? null : requestedVersion,
        totalChars: String(message || '').trim().length,
      },
      progress: { lastMessage: 'init' },
    });

    // Let the UI store the internal projectId without showing it to the user.
    send('progress', { stage: 'init', projectId, datasetVersion: requestedVersion === undefined ? null : requestedVersion });

    let ds = null;
    if (requestedVersion !== undefined && requestedVersion !== null && String(requestedVersion).trim() !== '') {
      const v = Number(requestedVersion);
      if (!Number.isInteger(v) || v <= 0) throw new Error('datasetVersion must be a positive integer');
      ds = await Dataset.findOne({ tenantId, projectId, version: v }).lean();
    } else {
      ds = await Dataset.findOne({ tenantId, projectId }).sort({ version: -1 }).lean();
    }
    if (!ds && !standardExplorerEnabled) {
      await setConversationJob(conversation, {
        type: 'governed_chat',
        status: 'succeeded',
        stage: 'not_found',
        finishedAt: new Date(),
        progress: { lastMessage: 'not_found' },
      });
      send('final', { html: finalizeHtml('NOT FOUND') });
      send('done', { ok: true });
      return res.end();
    }

    const datasetVersion = ds ? ds.version : null;
    await setConversationJob(conversation, {
      type: 'governed_chat',
      stage: 'dataset.selected',
      meta: { datasetVersion },
      progress: { lastMessage: 'dataset.selected' },
    });

    let allowedFilenames = [];
    if (ds) {
      const allowedFiles = await DatasetFile.find({
        tenantId,
        projectId,
        datasetVersion,
        approvalStatus: { $ne: 'rejected' },
        indexingStatus: 'done'
      }).select('filename').lean();
      allowedFilenames = Array.from(new Set((allowedFiles || []).map(x => x.filename).filter(Boolean))).slice(0, 200);
    }

    // In Standard Explorer mode we can answer purely from tenant standard library (no project files required).
    if (!allowedFilenames.length && !standardExplorerEnabled) {
      await setConversationJob(conversation, {
        type: 'governed_chat',
        status: 'succeeded',
        stage: 'not_found',
        finishedAt: new Date(),
        progress: { lastMessage: 'not_found' },
      });
      send('final', { html: finalizeHtml('NOT FOUND') });
      send('done', { ok: true });
      return res.end();
    }

    if (debugEnabled) {
      try { logger.info('governed.allowedFiles', { requestId: req.requestId, count: allowedFilenames.length, allowedFilenames }); } catch { }
    }

    await setConversationJob(conversation, {
      type: 'governed_chat',
      status: 'running',
      stage: 'retrieval.start',
      startedAt: new Date(),
      finishedAt: null,
      error: undefined,
      meta: {
        threadId,
        projectId,
        datasetVersion,
        files: allowedFilenames.map((n) => ({ name: n })),
        totalChars: String(message || '').trim().length,
      },
      progress: {
        filesTotal: allowedFilenames.length,
        filesProcessed: 0,
        lastMessage: 'retrieval.start',
      }
    });

    send('progress', { stage: 'retrieval.start', datasetVersion, files: allowedFilenames.length, standardExplorer: standardExplorerEnabled ? { standardRef: primaryStandardRef } : null });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';
    const qEmbedding = await createEmbeddingVector(openai, message, embeddingModel);
    if (debugEnabled) {
      try { logger.info('governed.embedding', { requestId: req.requestId, model: embeddingModel, dims: qEmbedding.length }); } catch { }
    }

    const pineconeEnabled = pinecone.isPineconeEnabled();
    const namespace = pineconeEnabled ? pinecone.resolveNamespace({ tenantId, projectId }) : null;
    if (debugEnabled) {
      try {
        logger.info('governed.backend', {
          requestId: req.requestId,
          pineconeEnabled,
          namespace,
        });
      } catch { }
    }

    let scoredTables = [];
    let scoredDocs = [];
    let scoredStandards = [];

    // --- Pre-retrieve a few doc snippets to help standard routing ---
    let routingEvidenceText = '';
    try {
      if (pineconeEnabled && Array.isArray(qEmbedding) && qEmbedding.length && allowedFilenames.length) {
        const baseFilter = {
          tenantId: String(tenantId),
          projectId: String(projectId),
          datasetVersion: Number(datasetVersion),
          filename: { $in: allowedFilenames },
          kind: 'doc_chunk',
        };
        const docMatches = await pinecone.queryVectors({ namespace, vector: qEmbedding, topK: 12, filter: baseFilter });
        const docIds = (docMatches || []).map(m => String(m?.id || '')).filter(Boolean).map(id => id.replace(/^doc:/, '')).slice(0, 12);
        if (docIds.length) {
          const docs = await DatasetDocChunk.find({ _id: { $in: docIds } }).select('filename text meta').lean();
          routingEvidenceText = docs.map(d => `FILE=${d.filename}\n${String(d.text || '').slice(0, 900)}`).join('\n\n---\n\n');
        }
      }
    } catch { }

    // --- Tenant-wide standard set routing (0..N sets) ---
    // If the previous assistant asked "choose 1/2/3", accept numeric reply without re-routing.
    const chosenFromNumeric = parseClarifyNumericSelection(conversation, message);
    let selectedSets = [];
    let clarify = null;
    if (!standardExplorerEnabled && chosenFromNumeric) {
      const doc = await StandardSet.findOne({ tenantId, _id: chosenFromNumeric }).populate('standardRefs').lean();
      selectedSets = doc ? [doc] : [];
    }
    if (!standardExplorerEnabled && !selectedSets.length) {
      ({ selectedSets, clarify } = await resolveStandardSelection({ tenantId, message, evidenceText: routingEvidenceText, openai }));
    }
    if (clarify) {
      if (debugEnabled) {
        try { logger.info('governed.standardSets.clarify', { requestId: req.requestId, options: clarify.options?.map(o => ({ i: o.i, name: o.name, key: o.key })) }); } catch { }
      }
      await setConversationJob(conversation, {
        type: 'governed_chat',
        status: 'succeeded',
        stage: 'clarify',
        finishedAt: new Date(),
        progress: { lastMessage: 'clarify' },
      });
      const html = finalizeHtml(clarify.questionHu);
      conversation.messages.push({ role: 'user', content: message, meta: { kind: 'chat-governed', projectId, datasetVersion } });
      conversation.messages.push({ role: 'assistant', content: html, images: [], meta: { kind: 'clarify_standard_set', options: clarify.options } });
      await conversation.save();
      send('final', { html });
      send('done', { ok: true });
      try { res.end(); } catch { }
      return;
    }

    const selectedStandardRefs = Array.from(new Set(
      (selectedSets || [])
        .flatMap(s => (Array.isArray(s.standardRefs) ? s.standardRefs : []))
        .map(r => String(r?._id || r))
        .filter(Boolean)
    ));
    if (standardExplorerEnabled && primaryStandardRef) {
      selectedStandardRefs.unshift(primaryStandardRef);
    }
    if (debugEnabled) {
      try {
        logger.info('governed.standardSets.selected', {
          requestId: req.requestId,
          sets: (selectedSets || []).map(s => ({ id: String(s?._id || ''), key: s.key, name: s.name })),
          selectedStandardRefsCount: selectedStandardRefs.length,
        });
      } catch { }
    }

    if (pineconeEnabled && Array.isArray(qEmbedding) && qEmbedding.length) {
      const finalTables = Number(systemSettings.getNumber('GOVERNED_RAG_TOPK') || 14);
      const finalDocs = Number(systemSettings.getNumber('GOVERNED_RAG_DOC_TOPK') || 10);
      const finalStd = Number(systemSettings.getNumber('GOVERNED_RAG_STD_TOPK') || 12);

      const candTables = Number(systemSettings.getNumber('GOVERNED_RAG_TABLE_CANDIDATES') || 50);
      const candDocs = Number(systemSettings.getNumber('GOVERNED_RAG_DOC_CANDIDATES') || 40);
      const candStd = Number(systemSettings.getNumber('GOVERNED_RAG_STD_CANDIDATES') || 60);

      const perFileTables = Number(systemSettings.getNumber('GOVERNED_RAG_TABLE_PER_FILE') || 3);
      const perFileDocs = Number(systemSettings.getNumber('GOVERNED_RAG_DOC_PER_FILE') || 3);
      const perStdRef = Number(systemSettings.getNumber('GOVERNED_RAG_STD_PER_STANDARD') || 6);

      const baseFilter = {
        tenantId: String(tenantId),
        projectId: String(projectId),
        datasetVersion: Number(datasetVersion),
        filename: { $in: allowedFilenames },
      };

      const tableMatches = allowedFilenames.length ? await pinecone.queryVectors({
        namespace,
        vector: qEmbedding,
        topK: candTables,
        filter: { ...baseFilter, kind: 'table_row' },
      }) : [];
      const docMatches = allowedFilenames.length ? await pinecone.queryVectors({
        namespace,
        vector: qEmbedding,
        topK: candDocs,
        filter: { ...baseFilter, kind: 'doc_chunk' },
      }) : [];
      const candImg = Number(systemSettings.getNumber('GOVERNED_RAG_IMG_CANDIDATES') || 20);
      const imgMatches = allowedFilenames.length ? await pinecone.queryVectors({
        namespace,
        vector: qEmbedding,
        topK: candImg,
        filter: { ...baseFilter, kind: 'image_chunk' },
      }) : [];

      // Standard library is stored under a separate "projectId" key for namespace isolation
      const stdNamespace = pinecone.resolveNamespace({ tenantId, projectId: 'standard-library' });
      const stdFilter = {
        tenantId: String(tenantId),
        kind: 'standard_clause',
      };
      // Standard retrieval:
      // - If a primary standard is pinned (Standard Explorer), prioritize that standard first.
      // - If results are weak, expand to full tenant library without forcing the user to pick sets.
      let stdMatches = [];
      if (selectedStandardRefs.length) {
        const primaryFilter = { ...stdFilter, standardRef: { $in: selectedStandardRefs } };
        stdMatches = await pinecone.queryVectors({ namespace: stdNamespace, vector: qEmbedding, topK: candStd, filter: primaryFilter });

        // Fallback expansion (still keep primary hits first).
        const minMatches = Math.max(
          4,
          Math.min(Number(systemSettings.getNumber('STANDARD_EXPLORER_FALLBACK_MIN_MATCHES') || 10), candStd)
        );
        if (standardExplorerEnabled && (stdMatches || []).length < minMatches) {
          const extra = await pinecone.queryVectors({ namespace: stdNamespace, vector: qEmbedding, topK: candStd, filter: stdFilter });
          const seen = new Set((stdMatches || []).map(m => String(m?.id || '')));
          for (const m of (extra || [])) {
            const id = String(m?.id || '');
            if (!id || seen.has(id)) continue;
            stdMatches.push(m);
            seen.add(id);
            if (stdMatches.length >= candStd) break;
          }
        }
      } else {
        stdMatches = await pinecone.queryVectors({ namespace: stdNamespace, vector: qEmbedding, topK: candStd, filter: stdFilter });
      }
      if (debugEnabled) {
        try {
          logger.info('governed.retrieval.pinecone.matches', {
            requestId: req.requestId,
            tableMatches: (tableMatches || []).length,
            docMatches: (docMatches || []).length,
            imgMatches: (imgMatches || []).length,
            stdMatches: (stdMatches || []).length,
          });
        } catch { }
      }

      // Fetch all candidates (bounded), then apply hybrid keyword boosts + optional LLM rerank, then per-file/per-standard caps.
      const maxCand = Math.max(10, Math.min(Number(systemSettings.getNumber('HYBRID_MAX_CANDIDATES') || 80), 250));

      const tableCand = (tableMatches || []).slice(0, maxCand).map(m => ({
        id: String(m?.id || '').replace(/^row:/, ''),
        vec: asNumber(m?.score),
        filename: String(m?.metadata?.filename || ''),
        sheet: String(m?.metadata?.sheet || ''),
        rowIndex: Number(m?.metadata?.rowIndex),
      })).filter(x => x.id);
      const docCand = (docMatches || []).slice(0, maxCand).map(m => ({
        id: String(m?.id || '').replace(/^doc:/, ''),
        vec: asNumber(m?.score),
        filename: String(m?.metadata?.filename || ''),
        chunkIndex: Number(m?.metadata?.chunkIndex),
        pageOrLoc: String(m?.metadata?.pageOrLoc || ''),
      })).filter(x => x.id);
      const imgCand = (imgMatches || []).slice(0, maxCand).map(m => ({
        id: String(m?.id || '').replace(/^img:/, ''),
        vec: asNumber(m?.score),
        filename: String(m?.metadata?.filename || ''),
        pageOrLoc: String(m?.metadata?.pageOrLoc || ''),
        pageNumber: Number(m?.metadata?.pageNumber),
      })).filter(x => x.id);
      const stdCand = (stdMatches || []).slice(0, maxCand).map(m => ({
        id: String(m?.id || '').replace(/^std:/, ''),
        vec: asNumber(m?.score),
        standardRef: String(m?.metadata?.standardRef || ''),
        clauseId: String(m?.metadata?.clauseId || ''),
        pageOrLoc: String(m?.metadata?.pageOrLoc || ''),
      })).filter(x => x.id);

      const rowDocs = tableCand.length
        ? await DatasetRowChunk.find({ _id: { $in: tableCand.map(x => x.id) } }).select('filename sheet rowIndex text').lean()
        : [];
      const docDocs = docCand.length
        ? await DatasetDocChunk.find({ _id: { $in: docCand.map(x => x.id) } }).select('filename chunkIndex text meta').lean()
        : [];
      const imgDocs = imgCand.length
        ? await DatasetImageChunk.find({ _id: { $in: imgCand.map(x => x.id) } }).select('filename pageNumber imageIndex text meta').lean()
        : [];
      const stdDocs = stdCand.length
        ? await StandardClause.find({ _id: { $in: stdCand.map(x => x.id) } }).select('standardId edition clauseId title pageOrLoc quoteId text standardRef seq').lean()
        : [];

      const rowById = new Map(rowDocs.map(d => [String(d._id), d]));
      const docById = new Map(docDocs.map(d => [String(d._id), d]));
      const imgById = new Map(imgDocs.map(d => [String(d._id), d]));
      const stdById = new Map(stdDocs.map(d => [String(d._id), d]));

      let tableRanked = tableCand
        .map(c => {
          const d = rowById.get(String(c.id));
          if (!d) return null;
          const text = String(d.text || '');
          return {
            id: String(d._id),
            kind: 'table_row',
            title: `${d.filename} ${d.sheet} row:${d.rowIndex}`,
            loc: `row:${d.rowIndex}`,
            text,
            _score: hybridScoreValue({ query: message, text, vectorScore: c.vec }),
            filename: String(d.filename || ''),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score);

      let docRanked = docCand
        .map(c => {
          const d = docById.get(String(c.id));
          if (!d) return null;
          const text = String(d.text || '');
          const loc = String(d?.meta?.pageOrLoc || c.pageOrLoc || `chunk:${Number(d?.chunkIndex || 0) + 1}`);
          return {
            id: String(d._id),
            kind: 'doc_chunk',
            title: `${d.filename}`,
            loc,
            text,
            _score: hybridScoreValue({ query: message, text, vectorScore: c.vec }),
            filename: String(d.filename || ''),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score);

      let imgRanked = imgCand
        .map(c => {
          const d = imgById.get(String(c.id));
          if (!d) return null;
          const text = String(d.text || '');
          const loc = String(d?.meta?.pageOrLoc || c.pageOrLoc || (Number.isInteger(d?.pageNumber) ? `page:${d.pageNumber} image:${Number(d?.imageIndex || 0) + 1}` : `image:${Number(d?.imageIndex || 0) + 1}`));
          return {
            id: String(d._id),
            kind: 'image_chunk',
            title: `${d.filename}`,
            loc,
            text,
            _score: hybridScoreValue({ query: message, text, vectorScore: c.vec }),
            filename: String(d.filename || ''),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score);

      let stdRanked = stdCand
        .map(c => {
          const d = stdById.get(String(c.id));
          if (!d) return null;
          const text = String(d.text || '');
          const title = `STD ${d.standardId}${d.edition ? `:${d.edition}` : ''} ${d.clauseId}`;
          return {
            id: String(d._id),
            kind: 'standard_clause',
            title,
            loc: String(d.pageOrLoc || c.pageOrLoc || ''),
            text,
            _score: hybridScoreValue({ query: message, text, vectorScore: c.vec }),
            key: String(d.standardRef || ''),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score);

      // Optional LLM rerank (per kind, keeps diversity logic later).
      try { tableRanked = await applyRerank({ query: message, kind: 'table_row', items: tableRanked, trace: { requestId: req.requestId } }); } catch { }
      try { docRanked = await applyRerank({ query: message, kind: 'doc_chunk', items: docRanked, trace: { requestId: req.requestId } }); } catch { }
      try { imgRanked = await applyRerank({ query: message, kind: 'image_chunk', items: imgRanked, trace: { requestId: req.requestId } }); } catch { }
      try { stdRanked = await applyRerank({ query: message, kind: 'standard_clause', items: stdRanked, trace: { requestId: req.requestId } }); } catch { }

      const selectedTable = pickByKey(tableRanked.map(it => ({ id: `row:${it.id}`, metadata: { filename: it.filename } })), {
        maxTotal: finalTables,
        perKey: perFileTables,
        keyFn: (m) => String(m?.metadata?.filename || 'file:unknown'),
      });
      const finalImg = Number(systemSettings.getNumber('GOVERNED_RAG_IMG_TOPK') || 6);
      const perFileImgs = Number(systemSettings.getNumber('GOVERNED_RAG_IMG_PER_FILE') || 1);
      const selectedDoc = pickByKey(docRanked.map(it => ({ id: `doc:${it.id}`, metadata: { filename: it.filename } })), {
        maxTotal: finalDocs,
        perKey: perFileDocs,
        keyFn: (m) => String(m?.metadata?.filename || 'file:unknown'),
      });
      const selectedImg = pickByKey(imgRanked.map(it => ({ id: `img:${it.id}`, metadata: { filename: it.filename } })), {
        maxTotal: finalImg,
        perKey: perFileImgs,
        keyFn: (m) => String(m?.metadata?.filename || 'file:unknown'),
      });
      const selectedStd = pickByKey(stdRanked.map(it => ({ id: `std:${it.id}`, metadata: { standardRef: it.key } })), {
        maxTotal: finalStd,
        perKey: perStdRef,
        keyFn: (m) => String(m?.metadata?.standardRef || 'std:unknown'),
      });

      const tableIds = selectedTable.map(m => String(m.id).replace(/^row:/, ''));
      const docIds = selectedDoc.map(m => String(m.id).replace(/^doc:/, ''));
      const imgIds = selectedImg.map(m => String(m.id).replace(/^img:/, ''));
      const stdIds = selectedStd.map(m => String(m.id).replace(/^std:/, ''));

      scoredTables = tableIds.map(id => rowById.get(id)).filter(Boolean);
      scoredDocs = docIds.map(id => docById.get(id)).filter(Boolean);
      const scoredImages = imgIds.map(id => imgById.get(id)).filter(Boolean);
      // Merge images into docs list for downstream context building (still marked separately).
      for (const im of scoredImages) scoredDocs.push(im);
      scoredStandards = stdIds.map(id => stdById.get(id)).filter(Boolean);
      if (debugEnabled) {
        try {
          logger.info('governed.retrieval.selected', {
            requestId: req.requestId,
            tables: scoredTables.length,
            docs: scoredDocs.length,
            standards: scoredStandards.length,
          });
        } catch { }
      }

      // Neighbor expansion for table rows (rowIndex +/- 2 within same file+sheet)
      const tableNeighbors = [];
      for (const r of scoredTables) {
        const rowIndex = Number(r?.rowIndex);
        const filename = r?.filename;
        const sheet = r?.sheet;
        if (!filename || !sheet || !Number.isInteger(rowIndex)) continue;
        for (let d = -2; d <= 2; d += 1) {
          if (d === 0) continue;
          tableNeighbors.push({ filename, sheet, rowIndex: rowIndex + d });
        }
      }
      if (tableNeighbors.length) {
        const or = tableNeighbors
          .filter(x => x.rowIndex >= 0)
          .slice(0, 120)
          .map(x => ({ filename: x.filename, sheet: x.sheet, rowIndex: x.rowIndex }));
        if (or.length) {
          const extra = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, $or: or })
            .select('filename sheet rowIndex text')
            .limit(120)
            .lean();
          const seen = new Set(scoredTables.map(x => String(x?._id)));
          for (const e of extra) {
            const id = String(e?._id);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            scoredTables.push(e);
          }
          scoredTables.sort((a, b) => {
            const fa = String(a?.filename || '');
            const fb = String(b?.filename || '');
            if (fa !== fb) return fa.localeCompare(fb);
            const sa = String(a?.sheet || '');
            const sb = String(b?.sheet || '');
            if (sa !== sb) return sa.localeCompare(sb);
            return Number(a?.rowIndex || 0) - Number(b?.rowIndex || 0);
          });
        }
      }

      // Neighbor expansion for standards (seq +/- 1)
      const neighborRadius = (standardExplorerEnabled && isDefinitionLikeQuestion(message)) ? 2 : 1;
      const neighbors = [];
      for (const s of scoredStandards) {
        const seq = Number(s?.seq || 0);
        const ref = s?.standardRef;
        if (!ref || !seq) continue;
        for (let d = 1; d <= neighborRadius; d += 1) {
          neighbors.push({ ref, seq: seq - d });
          neighbors.push({ ref, seq: seq + d });
        }
      }
      if (neighbors.length) {
        const or = neighbors
          .filter(x => x.seq > 0)
          .slice(0, 40)
          .map(x => ({ standardRef: x.ref, seq: x.seq }));
        if (or.length) {
          const extra = await StandardClause.find({ tenantId, $or: or })
            .select('standardId edition clauseId title pageOrLoc quoteId text standardRef seq')
            .limit(40)
            .lean();
          const seenStd = new Set(scoredStandards.map(x => String(x?._id)));
          for (const e of extra) {
            const id = String(e?._id);
            if (!id || seenStd.has(id)) continue;
            seenStd.add(id);
            scoredStandards.push(e);
            if (scoredStandards.length >= (finalStd + 12)) break;
          }
        }
      }
    } else {
      if (debugEnabled) {
        try {
          logger.info('governed.retrieval.mongo', {
            requestId: req.requestId,
            maxCandidates: Number(systemSettings.getNumber('GOVERNED_RAG_MAX_CANDIDATES') || 3500),
            maxDocCandidates: Number(systemSettings.getNumber('GOVERNED_RAG_MAX_DOC_CANDIDATES') || 2500),
          });
        } catch { }
      }
      // Fallback: local Mongo embedding arrays (legacy)
      const maxCandidates = Number(systemSettings.getNumber('GOVERNED_RAG_MAX_CANDIDATES') || 3500);
      const maxDocCandidates = Number(systemSettings.getNumber('GOVERNED_RAG_MAX_DOC_CANDIDATES') || 2500);

      const tableCandidates = await DatasetRowChunk.find({
        tenantId,
        projectId,
        datasetVersion,
        filename: { $in: allowedFilenames }
      }).select('filename sheet rowIndex text embedding').limit(maxCandidates).lean();

      const docCandidates = await DatasetDocChunk.find({
        tenantId,
        projectId,
        datasetVersion,
        filename: { $in: allowedFilenames }
      }).select('filename chunkIndex text meta embedding').limit(maxDocCandidates).lean();

      scoredTables = (tableCandidates || [])
        .map(c => ({ ...c, _score: cosineSimilarity(qEmbedding, c.embedding || []) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, Number(systemSettings.getNumber('GOVERNED_RAG_TOPK') || 14));

      scoredDocs = (docCandidates || [])
        .map(c => ({ ...c, _score: cosineSimilarity(qEmbedding, c.embedding || []) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, Number(systemSettings.getNumber('GOVERNED_RAG_DOC_TOPK') || 10));

      // Fallback standard retrieval from Mongo embeddings (if stored)
      const stdCandidates = await StandardClause.find({
        tenantId,
        ...(selectedStandardRefs.length ? { standardRef: { $in: selectedStandardRefs } } : {}),
      }).select('standardId edition clauseId title pageOrLoc quoteId text embedding').limit(2500).lean();
      scoredStandards = (stdCandidates || [])
        .map(c => ({ ...c, _score: cosineSimilarity(qEmbedding, c.embedding || []) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, Number(systemSettings.getNumber('GOVERNED_RAG_STD_TOPK') || 12));
    }

    const contextParts = [];
    let hasMeasEvalContext = false;
    let hasMeasCompareContext = false;

    // Optional: LLM planner chooses which deterministic XLSX tool to run.
    try {
      const hasXlsx = allowedFilenames.some(n => String(n).toLowerCase().endsWith('.xlsx') || String(n).toLowerCase().endsWith('.xls'));
      let planned = null;

      if (hasXlsx && xlsxPlanner.enabled()) {
        // Content-based hints: include an inexpensive XLSX preview (sheet/table/meta/labels).
        const xlsxList = allowedFilenames.filter(n => /\.xls(x)?$/i.test(String(n || ''))).slice(0, 6);
        let preview = null;
        try {
          preview = await xlsxPreview.buildXlsxPreview({
            tenantId,
            projectId,
            datasetVersion,
            filenames: xlsxList,
            trace: { requestId: req.requestId },
          });
        } catch { preview = null; }
        const hints = { xlsxFiles: xlsxList, xlsxPreview: preview };
        const r = await xlsxPlanner.buildPlan({ message, xlsxHints: hints, trace: { requestId: req.requestId } });
        if (r?.ok && r.plan?.steps?.length) planned = r.plan;
      }

      const step = planned?.steps?.[0] || null;
      const tool = String(step?.tool || '');
      const args = step?.args || {};

      // Fallback heuristic if planner is off/empty.
      const fallbackCompare = measEval.enabled() && measEval.detectCompareTablesIntent(message);
      const fallbackEval = measEval.enabled() && measEval.detectIntent(message);

      if (measEval.enabled() && tool === 'analyze_measurement_tables') {
        send('progress', { stage: 'meas.analyze.start' });
        const an = await measEval.analyzeMeasurementTables({
          tenantId,
          projectId,
          datasetVersion,
          allowedFilenames,
          message,
          options: args || null,
          trace: { requestId: req.requestId },
        });
        if (an?.ok && an?.result) {
          contextParts.push('MEASUREMENT_TABLE_ANALYSIS_CONTEXT (deterministic engineering-style XLSX analysis; use this for Table 1–4 meaning + steady-state/peak + within-supply comparisons):');
          contextParts.push(JSON.stringify(an.result).slice(0, 160000));
          contextParts.push('---');
          hasMeasEvalContext = true;
          hasMeasCompareContext = true;
          send('progress', { stage: 'meas.analyze.done', sheets: an.result.by_sheet?.length || 0 });
        }
      } else if (measEval.enabled() && (tool === 'compare_tables' || fallbackCompare)) {
        send('progress', { stage: 'meas.compare.start' });
        const cmp = await measEval.compareTablesColumns({
          tenantId,
          projectId,
          datasetVersion,
          allowedFilenames,
          message,
          options: tool === 'compare_tables' ? args : null,
          trace: { requestId: req.requestId },
        });
        if (cmp?.ok && cmp?.result) {
          contextParts.push('MEASUREMENT_COMPARE_CONTEXT (deterministic XLSX comparison; use this for Table 1–4 comparisons by column range):');
          contextParts.push(JSON.stringify(cmp.result).slice(0, 160000));
          contextParts.push('---');
          hasMeasCompareContext = true;
          send('progress', { stage: 'meas.compare.done', sheets: cmp.result.by_sheet?.length || 0 });
        }
      } else if (measEval.enabled() && (tool === 'evaluate_measurements' || fallbackEval)) {
        send('progress', { stage: 'meas.eval.start' });
        const ev = await measEval.evaluateXlsxMeasurements({
          tenantId,
          projectId,
          datasetVersion,
          allowedFilenames,
          trace: { requestId: req.requestId },
        });
        if (ev?.ok && ev?.result) {
          contextParts.push('MEASUREMENT_EVAL_CONTEXT (deterministic XLSX evaluation; prefer using these summaries instead of listing raw timeseries):');
          contextParts.push(JSON.stringify(ev.result).slice(0, 120000));
          contextParts.push('---');
          hasMeasEvalContext = true;
          send('progress', { stage: 'meas.eval.done', tests: ev.result.by_test?.length || 0 });
        }
      }
    } catch (e) {
      try { logger.warn('meas.eval.error', { requestId: req.requestId, error: e?.message || String(e) }); } catch { }
    }
    if (scoredStandards.length) {
      contextParts.push('STANDARD_CONTEXT (tenant library):');
      for (const s of scoredStandards) {
        contextParts.push(
          `STD_SOURCE standardRef=${String(s.standardRef || '')} standard=${s.standardId}${s.edition ? `:${s.edition}` : ''} clause=${s.clauseId} loc=${s.pageOrLoc} quoteId=${s.quoteId}\n${s.text}`.trim()
        );
        contextParts.push('---');
      }
    }
    if (scoredDocs.length) {
      contextParts.push('DOCUMENT_CONTEXT (standards, certificates, notes):');
      for (const d of scoredDocs) {
        const loc = String(d?.meta?.pageOrLoc || `chunk:${Number(d?.chunkIndex || 0) + 1}`);
        const isImage = !!(d && (Object.prototype.hasOwnProperty.call(d, 'imageIndex') || String(d?.meta?.source || '') === 'vision'));
        const prefix = isImage ? 'IMAGE_SOURCE' : 'DOC_SOURCE';
        contextParts.push(`${prefix} file=${d.filename} loc=${loc} sourceType=${isImage ? 'image' : 'document'}\n${d.text}`.trim());
        contextParts.push('---');
      }
    }
    if (scoredTables.length) {
      // If deterministic measurement contexts are present, avoid dumping large row+cell contexts.
      if (hasMeasEvalContext || hasMeasCompareContext) {
        contextParts.push('TABLE_CONTEXT (omitted because MEASUREMENT_*_CONTEXT is present):');
        contextParts.push(`rows=${scoredTables.length}`);
        contextParts.push('---');
      } else {
        contextParts.push('TABLE_CONTEXT (spreadsheets, row-wise + cell evidence):');
        for (const s of scoredTables) {
          contextParts.push(`ROW_SOURCE file=${s.filename} sheet=${s.sheet} row=${s.rowIndex}\n${s.text}`.trim());
          const cells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            filename: s.filename,
            sheet: s.sheet,
            rowIndex: s.rowIndex,
          }).select('filename sheet rowIndex colIndex cell colHeader valueRaw valueNumber').limit(120).lean();
          const cellLines = (cells || [])
            .filter(c => Number.isFinite(c.valueNumber))
            .slice(0, 80)
            .map(c => `CELL file=${c.filename} sheet=${c.sheet} row=${c.rowIndex} col=${c.colIndex} cell=${String(c.cell || '')} header=${String(c.colHeader || '').replace(/\s+/g, ' ').trim()} value=${c.valueRaw}`);
          if (cellLines.length) contextParts.push(cellLines.join('\n'));
          contextParts.push('---');
        }
      }

      // Add deterministic derived metrics (shortcuts). Still requires numericEvidence for the SOURCE cell values.
      try {
        const metricDocs = await DatasetDerivedMetric.find({
          tenantId,
          projectId,
          datasetVersion,
          filename: { $in: allowedFilenames },
        })
          .select('filename sheet derivedId metricKey label unit valueText sources')
          .sort({ filename: 1, sheet: 1, derivedId: 1 })
          .limit(220)
          .lean();

        if (metricDocs.length) {
          contextParts.push('TABLE_DERIVED (deterministic metrics; you may cite either the source cell(s) as numericEvidence.kind=cell, or the computed metric as numericEvidence.kind=computed with the listed sources):');
          for (const m of metricDocs.slice(0, 200)) {
            const srcs = Array.isArray(m.sources) ? m.sources : [];
            const srcTxt = srcs.length
              ? `sources=${srcs.map(s => `${s.cell || ''}(r=${s.rowIndex} c=${s.colIndex} v=${s.value})`).join(', ')}`
              : '';
            contextParts.push(
              `DERIVED file=${m.filename} sheet=${m.sheet} id=${m.derivedId} key=${m.metricKey} label=${m.label} value=${m.valueText}${m.unit ? ` ${m.unit}` : ''} ${srcTxt}`.trim()
            );
          }
          contextParts.push('---');
        }
      } catch { }
    }

    let systemPartsHu = [
      `NYELV: ${languageLabel(lang)}.`,
      `MÓD: ${answerMode === 'report' ? 'RIport/elemzés' : 'Chat'} (automatikus; a kérdés alapján).`,
      'Te egy mérnöki compliance / elemző asszisztens vagy.',
      'Csak a megadott bizonyíték kontextusból dolgozhatsz (STANDARD_CONTEXT + DOCUMENT_CONTEXT + TABLE_CONTEXT).',
      'Kimenet: STRICT JSON, nincs extra szöveg, nincs markdown fence.',
      answerMode === 'report'
        ? 'A JSON "answer" mezője legyen Markdown (ezt a UI HTML-ként rendereli): szöveges összefoglaló + legalább 1 táblázat.'
        : 'A JSON "answer" mezője legyen Markdown (ezt a UI HTML-ként rendereli). Chat módban válaszolj tömören és közvetlenül; táblázat csak akkor kell, ha tényleg segít.',
      answerMode === 'report'
        ? 'Kötelező logika: Követelmény → Bizonyíték → Értékelés.'
        : 'Chat módban nem kötelező a Követelmény → Bizonyíték → Értékelés struktúra; viszont minden lényegi állítást a kontextusban lévő bizonyítékhoz köss (idézet/cella), vagy jelöld UNKNOWN-ként.',
      'A megfelelőséget mindig a STANDARD_CONTEXT (szabvány) + DOCUMENT_CONTEXT (eszköz dokumentáció) + TABLE/MEASUREMENT_* (mérés) alapján döntsd el.',
      'A mátrix sorokban kizárólag ezeket a státuszokat használd: MEGFELELŐ | NEM MEGFELELŐ | FIGYELENDŐ | UNKNOWN.',
      'FIGYELENDŐ szabály: ha egy mért érték MEGFELELŐ ugyan (<= limit), de közel van a határhoz (pl. ≥ 90% a limithez képest), jelöld FIGYELENDŐ-nek és indokold röviden.',
      'FONTOS: a MEASUREMENT_COMPARE_CONTEXT.deltaThreshold_C csak "jelző" küszöb (significance), NEM szabványi követelmény. Ettől önmagában nem lesz NEM MEGFELELŐ.',
      'Ha van MEASUREMENT_TABLE_ANALYSIS_CONTEXT, akkor a "Table 1–4 mit jelentenek" + worst-case + trendek + jelentős eltérések részt abból készítsd.',
      'Ha van MEASUREMENT_EVAL_CONTEXT, akkor a mérési adatok kiértékelését abból készítsd, és ne próbálj a TABLE_CONTEXT-ből teljes idősorokat felsorolni.',
      'Ha van MEASUREMENT_COMPARE_CONTEXT, akkor a Table 1–4 / oszlop tartomány szerinti összehasonlítást abból készítsd.',
      answerMode === 'report'
        ? 'Kötelező elkülönítés: (1) "Eltéréselemzés" (trendek / jelentős különbségek) és (2) "Szabványi megfelelőség" (csak standard quote + limit + mért érték alapján).'
        : 'Ha megfelelőségről kérdeznek: csak standard quote + limit + mért érték alapján dönts; ha hiányzik, UNKNOWN + hiányzó bizonyíték.',
      answerMode === 'report'
        ? 'Ha csak eltérést látsz, de nincs standard limit/requirement a kérdéshez, akkor a megfelelőség legyen UNKNOWN (és írd le, milyen hiányzó bizonyíték kell).'
        : 'Chat módban csak akkor adj "megfelelőség" jellegű minősítést, ha a kérdés explicit erre vonatkozik; különben válaszolj normálisan a kérdésre.',
      'Statisztika: alapértelmezésben NEM végzel hipotézis-teszteket (p-value, α, ANOVA, Kruskal, stb.) és NEM kérdezel vissza ilyen paraméterekre. Ha a user explicit statisztikai tesztet kér, akkor tegyél fel 1 tisztázó kérdést, különben maradj mérnöki összehasonlításnál (worst-case, steady-state, trendek).',
      numericEvidenceRequired()
        ? 'Numerikus szabály: minden számszerű állítást csak úgy írhatsz le, ha bizonyítékkal lefedhető: vagy (A) numericEvidence-ben van forrás XLSX cella, vagy (B) a quotes egyik idézete tartalmazza ugyanazt a számot.'
        : 'Numerikus szabály: numericEvidence használata opcionális (nem kötelező). Törekedj arra, hogy a számokat a feltöltött anyagokból vezesd le; ha nem vagy biztos benne, jelöld a részt UNKNOWN-ként vagy fogalmazz óvatosan.',
      'FONTOS: IMAGE_SOURCE / képi OCR/vision eredményből származó szám NEM számít numerikus bizonyítéknak; ilyen számokra NE hivatkozz a válaszban.',
      'Ha egy szükséges számhoz nincs ilyen bizonyíték, azt a részt jelöld UNKNOWN-ként, és inkább ne írj számot.',
      'JSON séma:',
      '{ "answer": string, "numericEvidence": [',
      '  { "kind": "cell", "fileName": string, "sheet": string, "rowIndex": number, "colIndex": number, "cell": string, "value": string },',
      '  { "kind": "computed", "op": "delta|range|sum|avg", "value": string, "unit": string, "sources": [ { "fileName": string, "sheet": string, "rowIndex": number, "colIndex": number, "cell": string, "value": string } ] }',
	      '], "quotes": [ { "fileName": string, "standardRef": string|null, "clauseId": string|null, "pageOrLoc": string, "quote": string, "sourceType": "standard|document|image" } ] }',
      'A "numericEvidence" lista: XLSX cellák + (opcionális) számolt értékek forrás cellákkal. A "cell" mezőt töltsd ki, ha elérhető (pl. "C15").',
      'A "quotes" listában legyen rövid idézet (1-3 mondat) a releváns dokumentum/standard részről (fileName + pageOrLoc).',
      'Válasz struktúra javaslat: "Projekt összefoglaló", "Fő megállapítások", "Compliance mátrix" (Markdown táblázat), "Kockázatok / hiányok", "Következő lépések".'
    ];

    let systemPartsEn = [
      `LANGUAGE: ${languageLabel(lang)} (respond in this language).`,
      `MODE: ${answerMode === 'report' ? 'REPORT' : 'CHAT'} (auto; based on the user question).`,
      'You are an engineering compliance / analysis assistant.',
      'You may only use the provided evidence context (STANDARD_CONTEXT + DOCUMENT_CONTEXT + TABLE_CONTEXT).',
      'Output: STRICT JSON only. No extra text. No markdown fences.',
      answerMode === 'report'
        ? 'The JSON "answer" field must be Markdown (the UI renders it as HTML): short narrative + at least 1 table.'
        : 'The JSON "answer" field must be Markdown (the UI renders it as HTML). In CHAT mode, answer directly; only include tables if they truly help.',
      answerMode === 'report'
        ? 'Required logic: Requirement → Evidence → Assessment.'
        : 'In CHAT mode, Requirement → Evidence → Assessment is not required, but every key claim must be grounded in the provided evidence (quote/cell) or marked UNKNOWN.',
      'Decide compliance based on STANDARD_CONTEXT (standards) + DOCUMENT_CONTEXT (equipment documentation) + TABLE/MEASUREMENT_* (measurements).',
      'Allowed row statuses in the matrix: PASS | FAIL | WATCH | UNKNOWN.',
      'WATCH rule: if a measured value still passes (<= limit) but is close to the limit (e.g. ≥ 90% of the limit), mark it WATCH and explain briefly.',
      'IMPORTANT: MEASUREMENT_COMPARE_CONTEXT.deltaThreshold_C is only a significance flag, NOT a standards requirement. Do not label FAIL based on that alone.',
      'If MEASUREMENT_TABLE_ANALYSIS_CONTEXT is present, use it to explain what Table 1–4 represent, worst-case ranking, trends, and significant differences.',
      'If MEASUREMENT_EVAL_CONTEXT is present, use it for spreadsheet evaluation and do NOT enumerate full time series from TABLE_CONTEXT.',
      'If MEASUREMENT_COMPARE_CONTEXT is present, use it for Table 1–4 / column-range comparisons.',
      answerMode === 'report'
        ? 'Required separation: (1) "Difference analysis" (trends / significant deltas) and (2) "Standards compliance" (only when you have a standards requirement/limit quote + a measured value to compare).'
        : 'If the user asks about compliance, decide it only with a standards requirement/limit quote + a measured value; otherwise set UNKNOWN and list missing evidence.',
      answerMode === 'report'
        ? 'If you only see differences but have no relevant standards limit/requirement for the question, set compliance to UNKNOWN and list what evidence is missing.'
        : 'In CHAT mode, only produce a compliance-style matrix if the user explicitly asks for it.',
      'Statistics: by default do NOT perform hypothesis tests (p-value, alpha, ANOVA, Kruskal, etc.) and do NOT ask follow-up questions about these parameters. Only ask one clarifying question if the user explicitly requests a statistical test; otherwise use engineering comparisons (worst-case, steady-state, trends).',
      numericEvidenceRequired()
        ? 'Numeric rule: only include a numeric claim if it is covered by evidence: either (A) an XLSX cell in numericEvidence, or (B) one of the quotes contains the same number.'
        : 'Numeric rule: numericEvidence is optional (not required). Prefer deriving numbers from the uploaded evidence; if uncertain, mark UNKNOWN or hedge rather than inventing.',
      'IMPORTANT: numbers coming from IMAGE_SOURCE (image OCR/vision) are NOT valid numeric evidence; do not cite such numbers.',
      'If a required number is missing evidence, mark that part as UNKNOWN and prefer not to include the number.',
      'JSON schema:',
      '{ "answer": string, "numericEvidence": [',
      '  { "kind": "cell", "fileName": string, "sheet": string, "rowIndex": number, "colIndex": number, "cell": string, "value": string },',
      '  { "kind": "computed", "op": "delta|range|sum|avg", "value": string, "unit": string, "sources": [ { "fileName": string, "sheet": string, "rowIndex": number, "colIndex": number, "cell": string, "value": string } ] }',
	      '], "quotes": [ { "fileName": string, "standardRef": string|null, "clauseId": string|null, "pageOrLoc": string, "quote": string, "sourceType": "standard|document|image" } ] }',
      'The "numericEvidence" list must contain XLSX cells and (optionally) computed values with source cells. Fill "cell" if available (e.g., "C15").',
      'The "quotes" list must include short excerpts (1-3 sentences) from the relevant document/standard (fileName + pageOrLoc).',
      'Suggested structure: "Project summary", "Key findings", "Compliance matrix" (Markdown table), "Risks / gaps", "Next actions".'
    ];

    // Override style for Standard Explorer: quote + explain (legacy standard chat style).
    if (standardExplorerEnabled) {
      systemPartsHu.push(
        'STANDARD EXPLORER MÓD: ez a beszélgetés a tenant szabványtárából (PDF) dolgozik.',
        'Válasz stílus: a régi "standard chat" jelleg — NEM projekt-riport, NEM kötelező compliance mátrix, hacsak a user nem kéri.',
        'KÖTELEZŐ FORMÁTUM (ne térj el):',
        '1) Idézetek: a JSON "answer" mezőben a `<h3>Explanation:</h3>` sor ELŐTT kizárólag a pontos, szó szerinti idézet(ek) legyenek (címkék/forrás sorok/fejezetcímek nélkül), hogy a PDF-ben a kiemelés működjön.',
        '2) Ezután legyen pontosan: `<h3>Explanation:</h3>`',
        '3) Alatta rövid magyarázat magyarul: mit jelent az idézet a kérdés szempontjából + add meg, hol található (standardId, clauseId, pageOrLoc).',
        'Ha a teljes idézethez több STD_SOURCE rész kell (több chunk / szomszédos rész), akkor több bekezdésben idézz, mindegyiket szó szerint. Ne találj ki hiányzó részt.',
        'Kötelező: töltsd ki a "quotes" tömböt a felhasznált standard idézetekkel és add meg legalább: fileName/standardId, clauseId (ha elérhető), pageOrLoc, quote (rövid kivonat), sourceType="standard".',
        'TILOS ebben a módban: "Project summary", "Key findings", "Risks / gaps", "Recommended next actions" (vagy ezek magyar megfelelői), hacsak a user explicit nem kér kockázatelemzést vagy összefoglalót.',
        'Ha nincs releváns idézet a kontextusban, válasz: NOT FOUND.'
      );
      systemPartsEn.push(
        'STANDARD EXPLORER MODE: this thread answers from the tenant standard library (PDF).',
        'Response style: like the legacy "standard chat" — NOT a project-summary report and no compliance matrix unless the user explicitly asks.',
        'REQUIRED FORMAT (do not deviate):',
        '1) Quotes: in JSON "answer", BEFORE the exact line `<h3>Explanation:</h3>`, include ONLY exact verbatim quote(s) (no labels/source lines/headings) so PDF highlighting works.',
        '2) Then output exactly: `<h3>Explanation:</h3>`',
        '3) Then a short explanation in the user language + where it is found (standardId, clauseId, pageOrLoc).',
        'If the full quote spans multiple STD_SOURCE chunks, include multiple paragraphs of verbatim quotes. Do not invent missing text.',
        'Required: fill the "quotes" array with the standard excerpts you used, including at least: fileName/standardId, clauseId (if available), pageOrLoc, quote, sourceType="standard".',
        'Forbidden in this mode: "Project summary", "Key findings", "Risks / gaps", "Recommended next actions" unless the user explicitly requests a report/risk assessment.',
        'If no relevant quote is present in the provided context, return NOT FOUND.'
      );
    }

    const system = (lang === 'hu' ? systemPartsHu : systemPartsEn).join(' ');

    const user = [
      `PROJECT_ID: ${projectId}`,
      `DATASET_VERSION: ${datasetVersion}`,
      `STANDARD_SETS: ${selectedSets.length ? selectedSets.map(s => `${s.key}`).join(', ') : 'none'}`,
      'ALLOWED_FILES:',
      ...allowedFilenames.map(n => `- ${n}`),
      '',
      'EVIDENCE_CONTEXT:',
      contextParts.join('\n'),
      '',
      `QUESTION:\n${message}`
    ].join('\n');

    send('progress', { stage: 'assistant.start' });
    if (debugEnabled) {
      try {
        logger.info('governed.assistant.call', {
          requestId: req.requestId,
          model: systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') || 'gpt-5-mini',
          contextChars: user.length,
          standards: scoredStandards.length,
          docs: scoredDocs.length,
          tables: scoredTables.length,
        });
      } catch { }
    }
    const model = standardExplorerEnabled
      ? (systemSettings.getString('STANDARD_EXPLORER_MODEL') || 'gpt-4o-mini')
      : (systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') || 'gpt-5-mini');
    const maxOut = Math.max(600, Math.min(Number(systemSettings.getNumber('STANDARD_EXPLORER_MAX_OUTPUT_TOKENS') || 2500), 10000));
    const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

    // Strict JSON schema requirement (Responses API):
    // - every object schema must explicitly set additionalProperties:false
    // - and list all allowed properties.
    const numericCellSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['cell'] },
        fileName: { type: 'string' },
        sheet: { type: 'string' },
        rowIndex: { type: 'number' },
        colIndex: { type: 'number' },
        cell: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['kind', 'fileName', 'sheet', 'rowIndex', 'colIndex', 'cell', 'value'],
    };

    const numericComputedSourceSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        fileName: { type: 'string' },
        sheet: { type: 'string' },
        rowIndex: { type: 'number' },
        colIndex: { type: 'number' },
        cell: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['fileName', 'sheet', 'rowIndex', 'colIndex', 'cell', 'value'],
    };

    const numericComputedSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['computed'] },
        op: { type: 'string', enum: ['delta', 'range', 'sum', 'avg'] },
        value: { type: 'string' },
        unit: { type: 'string' },
        sources: { type: 'array', items: numericComputedSourceSchema },
      },
      required: ['kind', 'op', 'value', 'unit', 'sources'],
    };

	    const quoteSchema = {
	      type: 'object',
	      additionalProperties: false,
	      properties: {
	        fileName: { type: 'string' },
	        // Structured Outputs requires every key in `properties` to be listed in `required`.
	        // Optional fields must still be present (use null when unknown).
	        standardRef: { anyOf: [{ type: 'string' }, { type: 'null' }] },
	        clauseId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
	        pageOrLoc: { type: 'string' },
	        quote: { type: 'string' },
	        sourceType: { type: 'string', enum: ['standard', 'document', 'image'] },
	      },
	      required: ['fileName', 'standardRef', 'clauseId', 'pageOrLoc', 'quote', 'sourceType'],
	    };

	    const outSchema = {
	      type: 'object',
	      additionalProperties: false,
	      properties: {
	        answer: { type: 'string' },
	        // Structured Outputs supports `anyOf` (not `oneOf`) for unions.
	        numericEvidence: { type: 'array', items: { anyOf: [numericCellSchema, numericComputedSchema] } },
	        quotes: { type: 'array', items: quoteSchema },
	      },
	      required: ['answer', 'numericEvidence', 'quotes'],
	    };

	    const schemaIssues = validateStructuredOutputsJsonSchema(outSchema);
	    if (schemaIssues.length) {
	      logger.error('governed.output_schema.invalid', {
	        requestId: req.requestId || null,
	        issues: schemaIssues.slice(0, 50),
	      });
	      return res.status(500).json({ ok: false, error: 'Governed output schema is invalid. Check server logs.' });
	    }

	    const respObj = await createResponse({
	      model,
	      instructions: system,
	      input: [{ role: 'user', content: user }],
	      store: false,
      temperature: 0,
      maxOutputTokens: standardExplorerEnabled ? maxOut : null,
      textFormat: { type: 'json_schema', name: 'governed_answer', strict: true, schema: outSchema },
      timeoutMs: 120_000,
    });

    const txt = String(extractOutputTextFromResponse(respObj) || '').trim();

    let parsed = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      // Best-effort recovery: extract first JSON object.
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
      }
      if (!parsed) {
        try {
          logger.warn('governed.assistant.json_parse_failed', {
            requestId: req.requestId,
            model: systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') || 'gpt-5-mini',
            sample: txt.slice(0, 500),
          });
        } catch { }
      }
    }
    let answer = (parsed && typeof parsed.answer === 'string') ? parsed.answer : 'NOT FOUND';
    let numericEvidence = (parsed && Array.isArray(parsed.numericEvidence)) ? parsed.numericEvidence : [];
    let quotes = (parsed && Array.isArray(parsed.quotes)) ? parsed.quotes : [];

    function stripStandardExplorerScaffolding(answerText) {
      const txt = String(answerText || '');
      const explTag = '<h3>Explanation:</h3>';
      const idx = txt.indexOf(explTag);
      const before = idx >= 0 ? txt.slice(0, idx) : txt;
      const after = idx >= 0 ? txt.slice(idx) : '';

      const forbidden = [
        'project summary',
        'key findings',
        'compliance matrix',
        'risks / gaps',
        'recommended next actions',
        'next actions',
        // HU variants (in case model drifts)
        'projekt összefoglaló',
        'fő megállapítások',
        'compliance mátrix',
        'kockázatok / hiányok',
        'következő lépések',
      ];

      const cleanedBefore = before
        .split('\n')
        .filter(line => {
          const s = String(line || '').trim();
          if (!s) return false;
          const sLower = s.toLowerCase();
          const sLowerNoHash = sLower.replace(/^#+\s*/, '');
          if (forbidden.some(f => sLowerNoHash === f)) return false;
          if (sLowerNoHash.startsWith('question:')) return false;
          if (sLowerNoHash.startsWith('short answer:')) return false;
          if (sLowerNoHash.startsWith('references')) return false;
          if (sLowerNoHash.startsWith('hivatkozások')) return false;
          return true;
        })
        .join('\n')
        .trim();

      if (idx < 0) return cleanedBefore;
      return `${cleanedBefore}\n\n${after}`.trim();
    }

    function enrichQuotesWithStandardRef(quotes0) {
      const out = Array.isArray(quotes0) ? quotes0.map(q => ({ ...(q || {}) })) : [];
      const stdRefByStandardId = new Map();
      const stdRefByFileName = new Map();
      for (const s of scoredStandards || []) {
        if (s?.standardId && s?.standardRef) stdRefByStandardId.set(String(s.standardId), String(s.standardRef));
        if (s?.fileName && s?.standardRef) stdRefByFileName.set(String(s.fileName), String(s.standardRef));
      }

      function normName(v) {
        return String(v || '')
          .trim()
          .replace(/\.pdf$/i, '')
          .replace(/\s+/g, ' ');
      }

      for (const q of out) {
        const st = String(q?.sourceType || '').toLowerCase();
        if (st !== 'standard') continue;
        const existing = String(q?.standardRef || '').trim();
        if (existing) continue;

        const fileName = normName(q?.fileName);
        const stdId = normName(q?.standardId || q?.standard || q?.standard_id);

        const byStd = stdRefByStandardId.get(stdId);
        const byFile = stdRefByFileName.get(fileName) || stdRefByStandardId.get(fileName);
        const picked = byStd || byFile || '';
        if (picked) q.standardRef = picked;
      }
      return out;
    }

    if (standardExplorerEnabled) {
      function sanitizeStandardQuoteForDisplay(q) {
        return String(q || '')
          .replace(/\s*\[(?:SOURCE|Source):[^\]]+\]\s*/g, ' ')
          .replace(/\s*\((?:SOURCE|Source):[^)]+\)\s*/g, ' ')
          .replace(/\s*SOURCE:\s*.+$/gmi, ' ')
          .replace(/\u00A0/g, ' ')
          .replace(/\u00AD/g, '') // soft hyphen
          .replace(/\s+/g, ' ')
          .trim();
      }

      function extractExplanationText(answerText, lang0) {
        const txt = String(answerText || '').trim();
        if (!txt) return '';

        const tag = '<h3>Explanation:</h3>';
        const idx = txt.indexOf(tag);
        if (idx >= 0) return txt.slice(idx + tag.length).trim();

        // Accept looser headings and normalize to the exact tag later.
        const m = txt.match(/(?:^|\n)\s*(Explanation|Magyarázat)\s*:\s*(?:\n|$)/i);
        if (m && typeof m.index === 'number') {
          const cut = m.index + m[0].length;
          return txt.slice(cut).trim();
        }

        // Fallback: treat whole answer as explanation (we will rebuild the quote-block from quotes[] anyway).
        return txt;
      }

      answer = stripStandardExplorerScaffolding(answer);
      quotes = enrichQuotesWithStandardRef(quotes);

      // Hard-enforce the legacy format using the structured quotes[]:
      // - verbatim quotes first (no labels), then the exact <h3>Explanation:</h3>, then explanation.
      try {
        const stdQuotes = (Array.isArray(quotes) ? quotes : [])
          .filter(q => String(q?.sourceType || '').toLowerCase() === 'standard' && String(q?.quote || '').trim())
          .map(q => sanitizeStandardQuoteForDisplay(q.quote))
          .filter(Boolean);

        if (stdQuotes.length) {
          const explanation = extractExplanationText(answer, lang).trim();
          const quoteBlock = stdQuotes.join('\n\n');
          // Keep explanation even if empty (UI splitting depends on the tag).
          answer = `${quoteBlock}\n\n<h3>Explanation:</h3>\n\n${explanation}`.trim();
        }
      } catch { }
    }

    async function validateOrExplainFailure({ answerText, numericEvidence0, quotes0 }) {
      const out = { ok: true, uncovered: [], invalidEvidence: false };
      if (String(answerText).trim() === 'NOT FOUND') return out;
      // Standards-only / Standard Explorer chats may legitimately contain numbers without XLSX evidence.
      // In that case we skip numericEvidence enforcement to avoid false warnings.
      if (!datasetVersion) return out;
      if (!numericEvidenceRequired()) return out;
      const nums = extractAnswerNumericKeys(answerText);
      if (!nums.length) return out;

      const ok = await validateNumericEvidence({ tenantId, projectId, datasetVersion, numericEvidence: numericEvidence0 });
      if (!ok) {
        out.ok = false;
        out.invalidEvidence = true;
        out.uncovered = Array.from(new Set(nums)).slice(0, 60);
        return out;
      }

      const evidenceKeys = new Set();
      for (const e of (Array.isArray(numericEvidence0) ? numericEvidence0 : [])) {
        const v = parseNumberLoose(e?.value);
        if (Number.isFinite(v)) evidenceKeys.add(numKey(v));
        const sources = Array.isArray(e?.sources) ? e.sources : [];
        for (const s of sources) {
          const sv = parseNumberLoose(s?.value);
          if (Number.isFinite(sv)) evidenceKeys.add(numKey(sv));
        }
      }
      const quoteKeys = collectEvidenceNumberKeysFromQuotes(quotes0);
      const uncovered = nums.filter(k => !(evidenceKeys.has(k) || quoteKeys.has(k)));
      if (uncovered.length) {
        out.ok = false;
        out.uncovered = Array.from(new Set(uncovered)).slice(0, 60);
      }
      return out;
    }

    // Validate numeric claims. If uncovered numbers exist, keep the answer but visibly mark them.
    // If the numericEvidence itself is invalid (doesn't match DB cells), keep the answer but strip numericEvidence for safety.
    const v1 = await validateOrExplainFailure({ answerText: answer, numericEvidence0: numericEvidence, quotes0: quotes });
    if (!v1.ok) {
      try {
        logger.warn('governed.numeric.validation.failed', {
          requestId: req.requestId,
          invalidEvidence: !!v1.invalidEvidence,
          uncoveredCount: v1.uncovered.length,
          sample: v1.uncovered.slice(0, 12),
        });
      } catch { }

      // Mark uncovered numbers in the displayed answer (CSS hook via <span class="num-unverified">).
      if (v1.uncovered.length) {
        answer = annotateUncoveredNumbers(answer, v1.uncovered);
        answer = lang === 'hu'
          ? `${answer}\n\n> Megjegyzés: a kiemelt számokhoz nem találtam automatikus bizonyítékot (XLSX cella vagy idézet).`
          : `${answer}\n\n> Note: highlighted numbers have no automatic evidence (XLSX cell or quote).`;
      }
      if (v1.invalidEvidence) {
        numericEvidence = [];
        answer = lang === 'hu'
          ? `${answer}\n\n> Figyelmeztetés: a megadott numericEvidence nem volt validálható az XLSX cellákhoz, ezért ignoráltam.`
          : `${answer}\n\n> Warning: provided numericEvidence could not be validated against XLSX cells, so it was ignored.`;
      }
    }
    if (debugEnabled) {
      try {
        logger.info('governed.assistant.parsed', {
          requestId: req.requestId,
          notFound: String(answer).trim() === 'NOT FOUND',
          numericEvidenceCount: Array.isArray(numericEvidence) ? numericEvidence.length : 0,
          quotesCount: Array.isArray(quotes) ? quotes.length : 0,
        });
      } catch { }
    }

	    let answerForDisplay = answer;
	    if (!standardExplorerEnabled && String(answer).trim() !== 'NOT FOUND') {
	      const md = buildCitationsMarkdown(quotes, lang);
	      if (md) answerForDisplay = `${answerForDisplay}${md}`;
	    }

    const finalHtml = finalizeHtml(answerForDisplay);
    conversation.messages.push({
      role: 'user',
      content: message,
      meta: { kind: 'chat-governed', projectId, datasetVersion }
    });
    conversation.messages.push({
      role: 'assistant',
      content: finalHtml,
      images: [],
      meta: { numericEvidence: (String(answer).trim() === 'NOT FOUND') ? [] : numericEvidence, quotes }
    });
    await conversation.save();

    await setConversationJob(conversation, {
      type: 'governed_chat',
      status: 'succeeded',
      stage: 'done',
      finishedAt: new Date(),
      progress: { lastMessage: 'done' },
    });

    // If the user navigated away (SSE closed), send a notification when ready.
    if (req.sseClosed) {
      try {
        await notifyAndStore(String(userId), {
          type: 'governed-chat-done',
          title: 'Elemzés elkészült',
          message: `Az elemzés elkészült (projekt: ${projectId}, dataset v${datasetVersion}).`,
          data: { threadId, projectId, datasetVersion },
          meta: { requestId: req.requestId },
        });
      } catch { }
    }

    send('final', { html: finalHtml, quotes });
    send('done', { ok: true });
    try { logger.info('governed.done', { requestId: req.requestId, ok: true }); } catch { }
    try { res.end(); } catch { }
    return;
  } catch (e) {
    try { logger.error('governed.error', { requestId: req?.requestId, error: e?.message || 'Unexpected error' }); } catch { }
    send('error', { message: e?.message || 'Unexpected error' });
    send('done', { ok: false });

    try {
      const userId = req.userId;
      const tenantId = req.scope?.tenantId;
      const { threadId } = req.body || {};
      const conversation = await Conversation.findOne({ threadId, userId, tenantId });
      if (conversation) {
        await setConversationJob(conversation, {
          type: 'governed_chat',
          status: 'failed',
          stage: 'error',
          finishedAt: new Date(),
          error: { message: e?.message || 'Unexpected error' },
          progress: { lastMessage: 'error' },
        });
      }
    } catch { }

    if (req?.sseClosed) {
      try {
        await notifyAndStore(String(req.userId), {
          type: 'governed-chat-failed',
          title: 'Elemzés sikertelen',
          message: `Az elemzés sikertelen: ${e?.message || 'Ismeretlen hiba'}`,
          data: { threadId: req.body?.threadId || null, projectId: req.body?.projectId || null },
          meta: { requestId: req?.requestId },
        });
      } catch { }
    }

    try { res.end(); } catch { }
    return;
  }
};
