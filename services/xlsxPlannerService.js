const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

function enabled() {
  if (!systemSettings.getBoolean('XLSX_PLANNER_ENABLED')) return false;
  return !!process.env.OPENAI_API_KEY;
}

function safeJsonParse(s) {
  try { return JSON.parse(String(s || '')); } catch { return null; }
}

function normalizeTool(t) {
  const s = String(t || '').trim().toLowerCase();
  if (s === 'analyze_measurement_tables' || s === 'analyze_tables' || s === 'analyze') return 'analyze_measurement_tables';
  if (s === 'compare_tables' || s === 'compare') return 'compare_tables';
  if (s === 'evaluate_measurements' || s === 'meas_eval' || s === 'evaluate') return 'evaluate_measurements';
  if (s === 'none') return 'none';
  return 'none';
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function looksLikeTableCompare(message) {
  const s = String(message || '');
  const hasTables = /table\s*1/i.test(s) && /table\s*4/i.test(s);
  const hasRange = /\b([A-K])\s*(to|–|-)\s*([A-K])\b/i.test(s) || /columns?\s*[A-K]\s*(to|–|-)\s*[A-K]/i.test(s);
  const hasCompareWords = /\b(compare|comparative|differences|difference|elt[eé]r[eé]s|k[uü]l[oö]nbs[eé]g|[oö]sszehasonl|[oö]sszevet)\b/i.test(s);
  return (hasTables && (hasRange || /c\s*(to|–|-)\s*k/i.test(s))) && hasCompareWords;
}

function wantsStatsTest(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'alpha', 'α', 'anova', 't-test', 'ttest', 'kruskal', 'mann', 'whitney',
    'bonferroni', 'holm', 'multiple comparison', 'p-value', 'p value', 'statistically', 'significance level',
    'szignifik', 'p-érték', 'p ertek', 'anova', 'kruskal', 'mann–whitney', 'bonferroni', 'holm'
  ];
  return needles.some(n => s.includes(n));
}

function extractColumnRangeOrDefault(message) {
  const m = String(message || '').match(/\b([A-K])\s*(?:to|–|-)\s*([A-K])\b/i);
  if (!m) return 'C-K';
  const a = String(m[1] || '').toUpperCase();
  const b = String(m[2] || '').toUpperCase();
  return `${a}-${b}`;
}

function sanitizePlan(plan) {
  const out = {
    steps: [],
    needs_clarification: false,
    clarifying_question: '',
    assumptions: [],
  };
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (const s of steps.slice(0, 3)) {
    const tool = normalizeTool(s?.tool);
    if (tool === 'none') continue;
    const args0 = (s && typeof s === 'object' && s.args && typeof s.args === 'object') ? s.args : {};
    const args = {};
    if (tool === 'analyze_measurement_tables') {
      const col = String(args0.column_range || args0.columns || 'C-K').toUpperCase().replace(/\s+/g, '');
      args.column_range = /^[A-Z]+-[A-Z]+$/.test(col) ? col : 'C-K';
      const tables = Array.isArray(args0.tables) ? args0.tables.map(Number).filter(n => [1, 2, 3, 4].includes(n)) : [1, 2, 3, 4];
      args.tables = tables.length ? tables : [1, 2, 3, 4];
      args.mode = 'engineering_compare';
    }
    if (tool === 'compare_tables') {
      const col = String(args0.column_range || args0.columns || 'C-K').toUpperCase().replace(/\s+/g, '');
      args.column_range = /^[A-Z]+-[A-Z]+$/.test(col) ? col : 'C-K';
      const dt = args0.delta_threshold_C ?? args0.deltaThreshold_C ?? 3;
      args.delta_threshold_C = clamp(dt, 0.5, 50);
      const tables = Array.isArray(args0.tables) ? args0.tables.map(Number).filter(n => [1, 2, 3, 4].includes(n)) : [1, 2, 3, 4];
      args.tables = tables.length ? tables : [1, 2, 3, 4];
      args.mode = 'per_point_max';
    }
    if (tool === 'evaluate_measurements') {
      args.mode = 'summary';
    }
    out.steps.push({ tool, args });
  }
  out.needs_clarification = !!plan?.needs_clarification;
  out.clarifying_question = String(plan?.clarifying_question || '').trim();
  out.assumptions = Array.isArray(plan?.assumptions) ? plan.assumptions.map(String).slice(0, 6) : [];
  if (out.needs_clarification && !out.clarifying_question) {
    out.clarifying_question = 'Please clarify what comparison/metric you want from the spreadsheet.';
  }
  return out;
}

async function buildPlan({ message, xlsxHints = null, trace = null }) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'XLSX_PLANNER_ENABLED is off' };

  // Hard rule: for "compare Table 1–4 (C–K) significant differences" requests,
  // default to engineering analysis unless the user explicitly asks for statistics.
  if (looksLikeTableCompare(message) && !wantsStatsTest(message)) {
    const plan = sanitizePlan({
      steps: [{
        tool: 'analyze_measurement_tables',
        args: { column_range: extractColumnRangeOrDefault(message), tables: [1, 2, 3, 4] }
      }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [
        'Interpretation is engineering-style (worst-case and steady-state), not statistical hypothesis testing.',
      ],
    });
    try {
      logger.info('xlsx.planner.done', {
        requestId: trace?.requestId,
        model: 'hard-rule',
        steps: plan.steps.map(s => s.tool),
        needsClarification: plan.needs_clarification,
      });
    } catch { }
    return { ok: true, plan };
  }

  const model =
    systemSettings.getString('XLSX_PLANNER_MODEL') ||
    systemSettings.getString('FILE_CHAT_COMPLETIONS_MODEL') ||
    'gpt-5-mini';

  const sys = [
    'You are a planner for an audit-grade spreadsheet analysis system.',
    'You must NOT compute numbers. You only choose which deterministic tool(s) to run and with what parameters.',
    'You will receive XLSX previews (sheet names, Table markers, meta rows like Supply voltage, and example measurement point labels). Use this to choose the correct tool.',
    'Allowed tools:',
    '- analyze_measurement_tables: engineering-style comparative analysis for measurement workbooks (Table 1..4 semantics, steady-state/peak, within-supply comparisons).',
    '- compare_tables: compare Table 1..4 temperature points using a column range (e.g. C-K) and a delta threshold in °C.',
    '- evaluate_measurements: compute per-table/per-sheet summaries of temperature points (max/steady/external).',
    '- none: if the request is unrelated to XLSX analysis.',
    'Return STRICT JSON only. Do not add prose.',
  ].join(' ');

  const user = [
    'USER_QUESTION:',
    String(message || '').slice(0, 2000),
    '',
    'XLSX_HINTS (may be partial):',
    JSON.stringify(xlsxHints || {}).slice(0, 6000),
    '',
    'Output JSON schema:',
    '{',
    '  "steps": [',
    '    { "tool": "analyze_measurement_tables|compare_tables|evaluate_measurements|none", "args": { "column_range"?: "C-K", "delta_threshold_C"?: 3, "tables"?: [1,2,3,4] } }',
    '  ],',
    '  "needs_clarification": boolean,',
    '  "clarifying_question": string,',
    '  "assumptions": string[]',
    '}',
  ].join('\n');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: {
              type: 'string',
              enum: ['analyze_measurement_tables', 'compare_tables', 'evaluate_measurements', 'none'],
            },
            // Strict schema note:
            // In Responses strict JSON schema, optional keys are not supported the usual way.
            // We require all keys and allow null when a specific tool does not use a field.
            args: {
              type: 'object',
              additionalProperties: false,
              properties: {
                column_range: { type: ['string', 'null'] },
                delta_threshold_C: { type: ['number', 'null'] },
                tables: { type: ['array', 'null'], items: { type: 'number' } },
              },
              required: ['column_range', 'delta_threshold_C', 'tables'],
            },
          },
          required: ['tool', 'args'],
        }
      },
      needs_clarification: { type: 'boolean' },
      clarifying_question: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
    },
    required: ['steps', 'needs_clarification', 'clarifying_question', 'assumptions'],
  };

  const respObj = await createResponse({
    model,
    instructions: sys,
    input: [{ role: 'user', content: user }],
    store: false,
    temperature: 0,
    maxOutputTokens: 900,
    textFormat: { type: 'json_schema', name: 'xlsx_plan', strict: true, schema },
    timeoutMs: 60_000,
  });

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  const parsed = safeJsonParse(txt);
  const plan = sanitizePlan(parsed);

  try {
    logger.info('xlsx.planner.done', {
      requestId: trace?.requestId,
      model,
      steps: plan.steps.map(s => s.tool),
      needsClarification: plan.needs_clarification,
    });
  } catch { }

  return { ok: true, plan };
}

module.exports = {
  enabled,
  buildPlan,
  __test: {
    normalizeTool,
    sanitizePlan,
  }
};
