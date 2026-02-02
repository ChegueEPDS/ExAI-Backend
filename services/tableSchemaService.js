const OpenAI = require('openai');
const crypto = require('crypto');
const logger = require('../config/logger');

function tableSchemaEnabled() {
  const v = String(process.env.TABLE_SCHEMA_LLM_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getModel() {
  return process.env.TABLE_SCHEMA_MODEL || process.env.FILE_CHAT_COMPLETIONS_MODEL || 'gpt-5-mini';
}

function normalizeColLetter(s) {
  const v = String(s || '').trim().toUpperCase();
  return /^[A-Z]{1,3}$/.test(v) ? v : '';
}

function normalizeRowNumber(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0 || v > 1000000) return null;
  return v;
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function basicValidateSchema(schema) {
  if (!schema || typeof schema !== 'object') return { ok: false, error: 'schema is not an object' };
  const sheets = Array.isArray(schema.sheets) ? schema.sheets : [];
  if (!sheets.length) return { ok: false, error: 'schema.sheets missing/empty' };

  const normalized = { ...schema, sheets: [] };
  for (const sh of sheets.slice(0, 32)) {
    const sheet = String(sh?.sheet || sh?.name || '').trim();
    if (!sheet) continue;
    const tables0 = Array.isArray(sh?.tables) ? sh.tables : [];
    const tables = [];

    for (const t of tables0.slice(0, 24)) {
      const type = String(t?.type || '').trim();
      if (!type) continue;
      if (type === 'key_value') {
        const rowStart = normalizeRowNumber(t?.rowStart);
        const rowEnd = normalizeRowNumber(t?.rowEnd);
        const keyCol = normalizeColLetter(t?.keyCol);
        const valueCol = normalizeColLetter(t?.valueCol);
        if (!rowStart || !rowEnd || !keyCol || !valueCol) continue;
        tables.push({
          type,
          name: String(t?.name || 'Parameters').trim(),
          rowStart,
          rowEnd,
          keyCol,
          valueCol,
        });
        continue;
      }

      if (type === 'time_series') {
        const timeRow = normalizeRowNumber(t?.time?.row);
        const timeColStart = normalizeColLetter(t?.time?.colStart);
        const timeColEnd = normalizeColLetter(t?.time?.colEnd);
        if (!timeRow || !timeColStart || !timeColEnd) continue;

        const series0 = Array.isArray(t?.series) ? t.series : [];
        const series = [];
        for (const s of series0.slice(0, 256)) {
          const row = normalizeRowNumber(s?.row);
          const colStart = normalizeColLetter(s?.colStart || timeColStart);
          const colEnd = normalizeColLetter(s?.colEnd || timeColEnd);
          const name = String(s?.name || '').trim();
          if (!row || !colStart || !colEnd || !name) continue;
          series.push({
            name,
            row,
            unit: String(s?.unit || t?.unit || '').trim(),
            colStart,
            colEnd,
          });
        }
        if (!series.length) continue;
        tables.push({
          type,
          name: String(t?.name || 'Table').trim(),
          time: {
            row: timeRow,
            unit: String(t?.time?.unit || '').trim(),
            colStart: timeColStart,
            colEnd: timeColEnd,
          },
          series,
        });
        continue;
      }

      // Keep unknown types for future compatibility (but normalized).
      tables.push({ type, name: String(t?.name || '').trim(), raw: t });
    }

    normalized.sheets.push({ sheet, tables });
  }

  if (!normalized.sheets.length) return { ok: false, error: 'no valid sheets in schema' };
  return { ok: true, schema: normalized };
}

async function inferTableSchemaWithLLM({ filename, workbookPreview, trace = null }) {
  if (!tableSchemaEnabled()) return { ok: false, skipped: true, error: 'TABLE_SCHEMA_LLM_ENABLED is off' };

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = getModel();

  const system = [
    'You are a table structure extraction component for engineering spreadsheets.',
    'Given a workbook preview, infer tables and their coordinates.',
    'Return STRICT JSON only. No markdown. No extra text.',
    'Prefer two table types:',
    ' - key_value: a key/value list (Parameters).',
    ' - time_series: one header row of time values and multiple series rows (temperatures, voltages, etc).',
    'Use 1-based row numbers and Excel column letters (A, B, ..., AA).',
    'If uncertain, output the best guess with fewer tables rather than hallucinating.'
  ].join(' ');

  const user = [
    `FILENAME: ${String(filename || '').slice(0, 200)}`,
    'WORKBOOK_PREVIEW_JSON:',
    JSON.stringify(workbookPreview || {}).slice(0, 120000),
    '',
    'Output JSON schema (example):',
    '{ "sheets": [ { "sheet": "Sheet1", "tables": [',
    '  { "type": "key_value", "name": "Parameters", "rowStart": 1, "rowEnd": 12, "keyCol": "A", "valueCol": "B" },',
    '  { "type": "time_series", "name": "Table 1", "time": { "row": 14, "unit": "min", "colStart": "C", "colEnd": "K" },',
    '    "series": [ { "name": "T1 - driver Tc point", "row": 15, "unit": "°C", "colStart": "C", "colEnd": "K" } ] }',
    '] } ] }'
  ].join('\n');

  const resp = await openai.chat.completions.create({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
  });
  const txt = String(resp?.choices?.[0]?.message?.content || '').trim();

  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  const v = basicValidateSchema(parsed);
  if (!v.ok) {
    try {
      logger.warn('table.schema.invalid', {
        requestId: trace?.requestId,
        filename,
        error: v.error,
        model,
      });
    } catch { }
    return { ok: false, error: v.error, raw: txt.slice(0, 2000) };
  }

  const schema = v.schema;
  schema._meta = {
    inferredBy: 'llm',
    model,
    hash: stableHash(JSON.stringify(schema)),
    generatedAt: new Date().toISOString(),
  };

  try {
    logger.info('table.schema.ready', {
      requestId: trace?.requestId,
      filename,
      model,
      sheets: schema.sheets.length,
      tables: schema.sheets.reduce((a, s) => a + (Array.isArray(s.tables) ? s.tables.length : 0), 0),
    });
  } catch { }
  return { ok: true, schema };
}

module.exports = {
  inferTableSchemaWithLLM,
  tableSchemaEnabled,
};

