const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

function enabled() {
  if (!systemSettings.getBoolean('COMPLIANCE_CHECK_ENABLED')) return false;
  return !!process.env.OPENAI_API_KEY;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function trimText(s, maxLen) {
  const str = String(s || '');
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

async function buildComplianceMatrix({
  message,
  standards = [],
  docs = [],
  tables = [],
  lang = 'en',
  trace = null,
}) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'COMPLIANCE_CHECK_ENABLED is off' };

  const model =
    systemSettings.getString('COMPLIANCE_CHECK_MODEL') ||
    systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') ||
    'gpt-5-mini';

  const maxStds = clamp(systemSettings.getNumber('COMPLIANCE_CHECK_MAX_STANDARDS') || 12, 1, 30);
  const maxDocs = clamp(systemSettings.getNumber('COMPLIANCE_CHECK_MAX_DOCS') || 12, 1, 30);
  const maxTables = clamp(systemSettings.getNumber('COMPLIANCE_CHECK_MAX_TABLES') || 18, 1, 60);
  const maxChars = clamp(systemSettings.getNumber('COMPLIANCE_CHECK_MAX_CHARS') || 1200, 200, 5000);

  const stdItems = (standards || []).slice(0, maxStds).map(s => ({
    standardRef: s.standardRef || '',
    standardId: s.standardId || '',
    edition: s.edition || '',
    clauseId: s.clauseId || '',
    title: s.title || '',
    loc: s.pageOrLoc || '',
    quoteId: s.quoteId || '',
    text: trimText(s.text, maxChars),
  }));

  const docItems = (docs || []).slice(0, maxDocs).map(d => ({
    filename: d.filename || '',
    loc: d?.meta?.pageOrLoc || d?.meta?.loc || d?.chunkIndex || '',
    sourceType: d?.meta?.source || (d?.imageIndex !== undefined ? 'image' : 'document'),
    text: trimText(d.text, maxChars),
  }));

  const tableItems = (tables || []).slice(0, maxTables).map(t => ({
    filename: t.filename || '',
    sheet: t.sheet || '',
    rowIndex: t.rowIndex || '',
    text: trimText(t.text, maxChars),
  }));

  const isHu = String(lang || '').toLowerCase() === 'hu';
  const statuses = isHu
    ? ['MEGFELELŐ', 'NEM MEGFELELŐ', 'FIGYELENDŐ', 'UNKNOWN']
    : ['PASS', 'FAIL', 'WATCH', 'UNKNOWN'];

  const sys = [
    'You are a compliance extraction component.',
    'Produce a short requirements list and a compliance matrix.',
    'Use ONLY the provided standards, documents, and tables.',
    'If evidence is missing, mark status as UNKNOWN and explain what is missing.',
    `Allowed statuses: ${statuses.join(' | ')}.`,
    'Return STRICT JSON only. No prose.',
  ].join(' ');

  const user = [
    'QUESTION:',
    String(message || '').slice(0, 2000),
    '',
    'STANDARDS (authoritative requirements; cite in matrix):',
    JSON.stringify(stdItems).slice(0, 240000),
    '',
    'DOCUMENTS (equipment docs / certificates / notes):',
    JSON.stringify(docItems).slice(0, 240000),
    '',
    'TABLES (tabular evidence rows):',
    JSON.stringify(tableItems).slice(0, 240000),
    '',
    'Output JSON schema:',
    '{',
    '  "requirements": [',
    '    { "id": "R1", "clause": "standardRef clauseId", "requirement": "short requirement", "source": "STD ref clause loc quoteId" }',
    '  ],',
    '  "matrix": [',
    '    { "item": "short subject", "requirement_id": "R1", "status": "PASS|FAIL|WATCH|UNKNOWN", "evidence": "DOC/TABLE/STD ref", "notes": "short gap or rationale" }',
    '  ]',
    '}',
  ].join('\n');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            clause: { type: 'string' },
            requirement: { type: 'string' },
            source: { type: 'string' },
          },
          required: ['id', 'clause', 'requirement', 'source'],
        },
      },
      matrix: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            item: { type: 'string' },
            requirement_id: { type: 'string' },
            status: { type: 'string', enum: statuses },
            evidence: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['item', 'requirement_id', 'status', 'evidence', 'notes'],
        },
      },
    },
    required: ['requirements', 'matrix'],
  };

  const respObj = await createResponse({
    model,
    instructions: sys,
    input: [{ role: 'user', content: user }],
    store: false,
    temperature: 0,
    maxOutputTokens: 1200,
    textFormat: { type: 'json_schema', name: 'compliance_check', strict: true, schema },
    timeoutMs: 90_000,
  });

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.requirements) || !Array.isArray(parsed.matrix)) {
    try { logger.warn('compliance.check.parse.failed', { requestId: trace?.requestId }); } catch {}
    return { ok: false, error: 'parse_failed' };
  }

  return { ok: true, result: parsed };
}

module.exports = {
  enabled,
  buildComplianceMatrix,
};
