const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

function enabled() {
  if (!systemSettings.getBoolean('TABLE_QUERY_ENABLED')) return false;
  return !!process.env.OPENAI_API_KEY;
}

function safeJsonParse(s) {
  try { return JSON.parse(String(s || '')); } catch { return null; }
}

function clampInt(n, lo, hi, fallback = lo) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  return Math.max(lo, Math.min(hi, i));
}

function sanitizePlan(plan) {
  const out = {
    needs_clarification: !!plan?.needs_clarification,
    clarifying_question: String(plan?.clarifying_question || '').trim(),
    query: {
      filename: plan?.query?.filename ? String(plan.query.filename) : null,
      sheet: plan?.query?.sheet ? String(plan.query.sheet) : null,
      filters: Array.isArray(plan?.query?.filters) ? plan.query.filters : [],
      groupBy: Array.isArray(plan?.query?.groupBy) ? plan.query.groupBy : [],
      aggregations: Array.isArray(plan?.query?.aggregations) ? plan.query.aggregations : [],
      sort: plan?.query?.sort && typeof plan.query.sort === 'object' ? plan.query.sort : null,
      limit: plan?.query?.limit == null ? null : clampInt(plan.query.limit, 1, 200, 50),
      returnColumns: Array.isArray(plan?.query?.returnColumns) ? plan.query.returnColumns : [],
    },
    assumptions: Array.isArray(plan?.assumptions) ? plan.assumptions.map(String).slice(0, 8) : [],
  };

  if (out.needs_clarification && !out.clarifying_question) {
    out.clarifying_question = 'Melyik munkalapot / oszlopokat / szűrést használjam a számoláshoz?';
  }

  // Normalize filters/aggregations to a safe subset.
  const normCol = (s) => String(s || '').trim().slice(0, 120);

  out.query.filters = out.query.filters
    .map(f => ({
      column: normCol(f?.column),
      op: String(f?.op || '').trim().toLowerCase(),
      value: f?.value ?? null,
      value2: f?.value2 ?? null,
    }))
    .filter(f => f.column && ['=', '!=', 'contains', '>', '>=', '<', '<=', 'in', 'between'].includes(f.op))
    .slice(0, 12);

  out.query.groupBy = out.query.groupBy.map(normCol).filter(Boolean).slice(0, 6);

  out.query.aggregations = out.query.aggregations
    .map(a => ({
      op: String(a?.op || '').trim().toLowerCase(),
      column: a?.column == null ? null : normCol(a.column),
      as: a?.as == null ? null : String(a.as).trim().slice(0, 120),
    }))
    .filter(a => ['sum', 'avg', 'min', 'max', 'count'].includes(a.op))
    .slice(0, 10);

  if (out.query.sort) {
    const by = normCol(out.query.sort?.by);
    const dir = String(out.query.sort?.dir || 'desc').toLowerCase();
    out.query.sort = by ? { by, dir: (dir === 'asc' ? 'asc' : 'desc') } : null;
  }

  out.query.returnColumns = out.query.returnColumns.map(normCol).filter(Boolean).slice(0, 20);

  return out;
}

async function buildQueryPlan({ message, tabularHints = null, trace = null }) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'TABLE_QUERY_ENABLED is off' };

  const model =
    systemSettings.getString('TABLE_QUERY_MODEL') ||
    systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') ||
    'gpt-5-mini';

  const sys = [
    'You are a planner for answering questions using only spreadsheet data that the user uploaded.',
    'You must NOT compute numbers. You only produce a deterministic query plan.',
    'Prefer: filter -> groupBy -> aggregations -> sort -> limit.',
    'If the question is ambiguous (which sheet/column/time window), ask ONE clarifying question.',
    'Return STRICT JSON only.',
  ].join(' ');

  const user = [
    'USER_QUESTION:',
    String(message || '').slice(0, 2500),
    '',
    'TABULAR_HINTS (may be partial):',
    JSON.stringify(tabularHints || {}).slice(0, 120000),
    '',
    'Output JSON schema:',
    '{',
    '  "needs_clarification": boolean,',
    '  "clarifying_question": string,',
    '  "query": {',
    '    "filename": string|null,',
    '    "sheet": string|null,',
    '    "filters": [{ "column": string, "op": "=|!=|contains|>|>=|<|<=|in|between", "value": any, "value2": any|null }],',
    '    "groupBy": string[],',
    '    "aggregations": [{ "op": "sum|avg|min|max|count", "column": string|null, "as": string|null }],',
    '    "sort": { "by": string, "dir": "asc|desc" }|null,',
    '    "limit": number|null,',
    '    "returnColumns": string[]',
    '  },',
    '  "assumptions": string[]',
    '}',
  ].join('\n');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      needs_clarification: { type: 'boolean' },
      clarifying_question: { type: 'string' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filename: { type: ['string', 'null'] },
          sheet: { type: ['string', 'null'] },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                column: { type: 'string' },
                op: { type: 'string' },
                value: {},
                value2: {},
              },
              required: ['column', 'op', 'value', 'value2'],
            }
          },
          groupBy: { type: 'array', items: { type: 'string' } },
          aggregations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                op: { type: 'string' },
                column: { type: ['string', 'null'] },
                as: { type: ['string', 'null'] },
              },
              required: ['op', 'column', 'as'],
            }
          },
          sort: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  by: { type: 'string' },
                  dir: { type: 'string' },
                },
                required: ['by', 'dir'],
              }
            ]
          },
          limit: { type: ['number', 'null'] },
          returnColumns: { type: 'array', items: { type: 'string' } },
        },
        required: ['filename', 'sheet', 'filters', 'groupBy', 'aggregations', 'sort', 'limit', 'returnColumns'],
      },
      assumptions: { type: 'array', items: { type: 'string' } },
    },
    required: ['needs_clarification', 'clarifying_question', 'query', 'assumptions'],
  };

  const respObj = await createResponse({
    model,
    instructions: sys,
    input: [{ role: 'user', content: user }],
    store: false,
    temperature: 0,
    maxOutputTokens: 1200,
    textFormat: { type: 'json_schema', name: 'table_query_plan', strict: true, schema },
    timeoutMs: 60_000,
  });

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  const parsed = safeJsonParse(txt);
  const plan = sanitizePlan(parsed);

  try {
    logger.info('table.query.planner.done', {
      requestId: trace?.requestId,
      model,
      needsClarification: plan.needs_clarification,
      hasGroupBy: !!plan.query.groupBy?.length,
      aggs: plan.query.aggregations?.map(a => a.op).slice(0, 4),
    });
  } catch { }

  return { ok: true, plan };
}

module.exports = {
  enabled,
  buildQueryPlan,
  __test: { sanitizePlan },
};

