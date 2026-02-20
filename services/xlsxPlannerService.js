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
  if (s === 'table_query' || s === 'table' || s === 'tabular' || s === 'query_table') return 'table_query';
  if (s === 'table_profile' || s === 'profile' || s === 'data_profile') return 'table_profile';
  if (s === 'table_compare' || s === 'compare_table' || s === 'diff_table' || s === 'table_diff') return 'table_compare';
  if (s === 'table_pivot' || s === 'pivot' || s === 'grouped_summary' || s === 'group_by') return 'table_pivot';
  if (s === 'time_series' || s === 'timeseries' || s === 'idősor' || s === 'idosor' || s === 'trend') return 'time_series';
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

function looksLikeMeasurementEval(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'service temperature', 'ts', 'tmax', 'max surface', 'maximum surface',
    'ambient', 'környezeti', 'kornyezeti', 'külső', 'kulso',
    't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8',
    'luminaire', 'explosion proof', 'temperature class', 't-class',
    'mérési', 'meresi', 'hőmérséklet', 'homerseklet',
  ];
  return needles.some(n => s.includes(n));
}

function looksLikeProfile(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'profile', 'profil', 'profiloz', 'adatmin',
    'missing', 'hiány', 'hiany',
    'outlier', 'szelsoertek', 'szélsőérték',
    'data quality', 'minőség', 'minoseg',
    'null', 'empty', 'üres', 'ures',
  ];
  return needles.some(n => s.includes(n));
}

function looksLikeTableCompareGeneric(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'compare', 'comparison', 'difference', 'diff', 'eltérés', 'különbség', 'összehasonl', 'összevet',
    'sheet', 'tab', 'munkalap', 'lap', 'worksheet',
    'file', 'fájl', 'excel',
  ];
  const hasCompare = needles.some(n => s.includes(n));
  const notTable14 = !(/table\s*1/i.test(s) && /table\s*4/i.test(s));
  return hasCompare && notTable14;
}

function looksLikePivot(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'pivot', 'kimutat', 'csoportos', 'összesít', 'osszesit',
    'group by', 'group-by', 'groupby', 'grouped',
    'sum by', 'average by', 'átlag', 'atlag', 'összeg', 'osszeg',
  ];
  return needles.some(n => s.includes(n));
}

function looksLikeTimeSeries(message) {
  const s = String(message || '').toLowerCase();
  const needles = [
    'time series', 'timeseries', 'idősor', 'idosor',
    'resample', 'rolling', 'moving average', 'trend', 'slope',
    'hourly', 'daily', 'weekly', 'monthly',
  ];
  return needles.some(n => s.includes(n));
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
    if (tool === 'table_query') {
      args.mode = 'auto';
    }
    if (tool === 'table_profile') {
      args.mode = 'profile';
    }
    if (tool === 'table_compare') {
      const leftFilename = args0.left_filename ?? args0.leftFilename ?? args0.left_file ?? args0.leftFile ?? null;
      const rightFilename = args0.right_filename ?? args0.rightFilename ?? args0.right_file ?? args0.rightFile ?? null;
      const leftSheet = args0.left_sheet ?? args0.leftSheet ?? null;
      const rightSheet = args0.right_sheet ?? args0.rightSheet ?? null;
      const keyColsRaw = args0.key_columns ?? args0.keyColumns ?? args0.key_column ?? args0.keyColumn ?? null;
      const compareColsRaw = args0.compare_columns ?? args0.compareColumns ?? args0.compare_column ?? args0.compareColumn ?? null;
      const keyColumns = Array.isArray(keyColsRaw)
        ? keyColsRaw.map(String).filter(Boolean).slice(0, 12)
        : (keyColsRaw ? [String(keyColsRaw)].filter(Boolean) : []);
      const compareColumns = Array.isArray(compareColsRaw)
        ? compareColsRaw.map(String).filter(Boolean).slice(0, 20)
        : (compareColsRaw ? [String(compareColsRaw)].filter(Boolean) : []);
      args.mode = 'compare';
      args.left_filename = leftFilename ? String(leftFilename) : null;
      args.right_filename = rightFilename ? String(rightFilename) : null;
      args.left_sheet = leftSheet ? String(leftSheet) : null;
      args.right_sheet = rightSheet ? String(rightSheet) : null;
      args.key_columns = keyColumns;
      args.compare_columns = compareColumns;
    }
    if (tool === 'table_pivot') {
      const filename = args0.filename ?? args0.file ?? args0.file_name ?? null;
      const sheet = args0.sheet ?? args0.sheet_name ?? null;
      const groupByRaw = args0.group_by ?? args0.groupBy ?? args0.groupby ?? args0.group ?? null;
      const valuesRaw = args0.values ?? args0.value_columns ?? args0.valueCols ?? null;
      const aggRaw = args0.agg ?? args0.aggregations ?? args0.aggregation ?? null;

      const groupBy = Array.isArray(groupByRaw)
        ? groupByRaw.map(String).filter(Boolean).slice(0, 12)
        : (groupByRaw ? [String(groupByRaw)].filter(Boolean) : []);
      const values = Array.isArray(valuesRaw)
        ? valuesRaw.map(String).filter(Boolean).slice(0, 12)
        : (valuesRaw ? [String(valuesRaw)].filter(Boolean) : []);
      const agg = Array.isArray(aggRaw)
        ? aggRaw.map(String).filter(Boolean).slice(0, 12)
        : (aggRaw ? [String(aggRaw)].filter(Boolean) : []);

      args.mode = 'pivot';
      args.filename = filename ? String(filename) : null;
      args.sheet = sheet ? String(sheet) : null;
      args.group_by = groupBy;
      args.values = values;
      args.agg = agg;
    }
    if (tool === 'time_series') {
      const filename = args0.filename ?? args0.file ?? args0.file_name ?? null;
      const sheet = args0.sheet ?? args0.sheet_name ?? null;
      const timeColumn = args0.time_column ?? args0.timeColumn ?? args0.time ?? null;
      const valueColsRaw = args0.value_columns ?? args0.valueColumns ?? args0.values ?? null;
      const freq = args0.freq ?? args0.resample ?? null;
      const agg = args0.agg ?? args0.aggregation ?? null;
      const trendWindow = args0.trend_window ?? args0.trendWindow ?? args0.window ?? null;

      const valueColumns = Array.isArray(valueColsRaw)
        ? valueColsRaw.map(String).filter(Boolean).slice(0, 12)
        : (valueColsRaw ? [String(valueColsRaw)].filter(Boolean) : []);

      args.mode = 'time_series';
      args.filename = filename ? String(filename) : null;
      args.sheet = sheet ? String(sheet) : null;
      args.time_column = timeColumn ? String(timeColumn) : null;
      args.value_columns = valueColumns;
      args.freq = freq ? String(freq) : null;
      args.agg = agg ? String(agg) : null;
      args.trend_window = trendWindow ? Number(trendWindow) : null;
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

  // Hard rule: if user asks for data quality / missing / outliers, use table_profile.
  if (looksLikeProfile(message)) {
    const plan = sanitizePlan({
      steps: [{ tool: 'table_profile', args: {} }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [],
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

  // Hard rule: measurement evaluation (Ts / Tmax / ambient / T1..T8)
  if (looksLikeMeasurementEval(message)) {
    const plan = sanitizePlan({
      steps: [{ tool: 'evaluate_measurements', args: {} }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [
        'Use deterministic measurement evaluation (max/steady/ambient) across all detected tables.',
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

  if (looksLikeTableCompareGeneric(message)) {
    const plan = sanitizePlan({
      steps: [{ tool: 'table_compare', args: {} }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [],
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

  if (looksLikePivot(message)) {
    const plan = sanitizePlan({
      steps: [{ tool: 'table_pivot', args: {} }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [],
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

  if (looksLikeTimeSeries(message)) {
    const plan = sanitizePlan({
      steps: [{ tool: 'time_series', args: {} }],
      needs_clarification: false,
      clarifying_question: '',
      assumptions: [],
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
    '- evaluate_measurements: compute per-table/per-sheet summaries of temperature points (max/steady/external), and derive ambient + Ts-rise when possible.',
    '- table_query: general-purpose tabular query for normal spreadsheets (filter, group-by, sum/avg/min/max/count).',
    '- table_profile: profile a spreadsheet (missing values, outliers, data quality).',
    '- table_compare: compare two sheets/files by key columns and report added/removed/changed rows.',
    '- table_pivot: grouped summary (group-by with aggregations).',
    '- time_series: resample time series and compute trends.',
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
    '    { "tool": "analyze_measurement_tables|compare_tables|evaluate_measurements|table_query|table_profile|table_compare|table_pivot|time_series|none", "args": { "column_range"?: "C-K", "delta_threshold_C"?: 3, "tables"?: [1,2,3,4,5,6,7,8], "left_filename"?: "file.xlsx", "right_filename"?: "file2.xlsx", "left_sheet"?: "Sheet1", "right_sheet"?: "Sheet2", "key_columns"?: ["id"], "compare_columns"?: ["value","status"], "filename"?: "file.xlsx", "sheet"?: "Sheet1", "group_by"?: ["colA"], "values"?: ["colB"], "agg"?: ["sum"], "time_column"?: "date", "value_columns"?: ["value"], "freq"?: "D", "trend_window"?: 7 } }',
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
              enum: ['analyze_measurement_tables', 'compare_tables', 'evaluate_measurements', 'table_query', 'table_profile', 'table_compare', 'table_pivot', 'time_series', 'none'],
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
                left_filename: { type: ['string', 'null'] },
                right_filename: { type: ['string', 'null'] },
                left_sheet: { type: ['string', 'null'] },
                right_sheet: { type: ['string', 'null'] },
                key_columns: { type: ['array', 'null'], items: { type: 'string' } },
                compare_columns: { type: ['array', 'null'], items: { type: 'string' } },
                filename: { type: ['string', 'null'] },
                sheet: { type: ['string', 'null'] },
                group_by: { type: ['array', 'null'], items: { type: 'string' } },
                values: { type: ['array', 'null'], items: { type: 'string' } },
                agg: { type: ['array', 'null'], items: { type: 'string' } },
                time_column: { type: ['string', 'null'] },
                value_columns: { type: ['array', 'null'], items: { type: 'string' } },
                freq: { type: ['string', 'null'] },
                trend_window: { type: ['number', 'null'] },
              },
              required: [
                'column_range',
                'delta_threshold_C',
                'tables',
                'left_filename',
                'right_filename',
                'left_sheet',
                'right_sheet',
                'key_columns',
                'compare_columns',
                'filename',
                'sheet',
                'group_by',
                'values',
                'agg',
                'time_column',
                'value_columns',
                'freq',
                'trend_window',
              ],
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
