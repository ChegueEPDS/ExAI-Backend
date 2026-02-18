const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');

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

function parseRowChunkText(text) {
  const lines = String(text || '').split('\n');
  const body = lines.slice(3).join('\n');
  const parts = body.split('|').map(s => s.trim()).filter(Boolean);
  const obj = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const key = p.slice(0, idx).trim();
    const value = p.slice(idx + 1).trim();
    if (!key) continue;
    obj[key] = value;
  }
  return obj;
}

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
}

function resolveColumnName(rowObj, wantColumn) {
  const want = normalizeKey(wantColumn);
  if (!want) return null;
  const keys = Object.keys(rowObj || {});
  const direct = keys.find(k => normalizeKey(k) === want);
  if (direct) return direct;
  // soft match: remove spaces and punctuation
  const simplify = (x) => normalizeKey(x).replace(/[^a-z0-9]/g, '');
  const w2 = simplify(want);
  if (!w2) return null;
  return keys.find(k => simplify(k) === w2) || null;
}

function coerceComparable(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseNumberLoose(s);
  if (n !== null) return n;
  return s;
}

function applyFilter(rowObj, f) {
  const col = resolveColumnName(rowObj, f?.column);
  const raw = col ? rowObj[col] : null;
  const left = coerceComparable(raw);
  const op = String(f?.op || '').trim().toLowerCase();

  if (op === 'contains') {
    const needle = String(f?.value ?? '').toLowerCase();
    if (!needle) return true;
    return String(raw ?? '').toLowerCase().includes(needle);
  }

  if (op === 'in') {
    const arr = Array.isArray(f?.value) ? f.value : [f?.value];
    const wantSet = new Set(arr.map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean));
    if (!wantSet.size) return true;
    return wantSet.has(String(raw ?? '').trim().toLowerCase());
  }

  if (op === 'between') {
    const a = coerceComparable(f?.value);
    const b = coerceComparable(f?.value2);
    if (left == null || a == null || b == null) return false;
    if (typeof left === 'number' && typeof a === 'number' && typeof b === 'number') {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return left >= lo && left <= hi;
    }
    const s = String(left).toLowerCase();
    const s1 = String(a).toLowerCase();
    const s2 = String(b).toLowerCase();
    return s >= s1 && s <= s2;
  }

  const right = coerceComparable(f?.value);
  if (left == null || right == null) {
    if (op === '!=') return true;
    if (op === '=') return false;
    return false;
  }

  // Numeric comparisons if both numeric, else string comparisons.
  if (typeof left === 'number' && typeof right === 'number') {
    if (op === '=') return left === right;
    if (op === '!=') return left !== right;
    if (op === '>') return left > right;
    if (op === '>=') return left >= right;
    if (op === '<') return left < right;
    if (op === '<=') return left <= right;
    return false;
  }

  const ls = String(left).toLowerCase();
  const rs = String(right).toLowerCase();
  if (op === '=') return ls === rs;
  if (op === '!=') return ls !== rs;
  if (op === '>') return ls > rs;
  if (op === '>=') return ls >= rs;
  if (op === '<') return ls < rs;
  if (op === '<=') return ls <= rs;
  return false;
}

function groupKey(rowObj, cols) {
  const parts = [];
  for (const c of cols || []) {
    const real = resolveColumnName(rowObj, c);
    const v = real ? rowObj[real] : '';
    parts.push(`${String(c)}=${String(v ?? '')}`);
  }
  return parts.join('|');
}

function aggregateRows(rows, plan) {
  const groupBy = Array.isArray(plan?.groupBy) ? plan.groupBy : [];
  const aggs = Array.isArray(plan?.aggregations) ? plan.aggregations : [];
  if (!groupBy.length && !aggs.length) return null;
  const groups = new Map(); // key -> { keyVals, rows }

  if (!groupBy.length) {
    groups.set('__all__', { keyVals: {}, rows });
  } else {
    for (const r of rows) {
      const k = groupKey(r, groupBy);
      if (!groups.has(k)) {
        const keyVals = {};
        for (const c of groupBy) {
          const real = resolveColumnName(r, c);
          keyVals[c] = real ? r[real] : null;
        }
        groups.set(k, { keyVals, rows: [] });
      }
      groups.get(k).rows.push(r);
    }
  }

  const outRows = [];
  for (const g of groups.values()) {
    const base = { ...(g.keyVals || {}) };
    for (const a of aggs) {
      const op = String(a?.op || '').toLowerCase();
      const colWant = a?.column;
      const as = String(a?.as || `${op}${colWant ? `_${colWant}` : ''}`).trim() || op;

      if (op === 'count') {
        base[as] = g.rows.length;
        continue;
      }

      const nums = [];
      for (const r of g.rows) {
        const real = resolveColumnName(r, colWant);
        if (!real) continue;
        const n = parseNumberLoose(r[real]);
        if (n === null) continue;
        nums.push(n);
      }
      if (!nums.length) {
        base[as] = null;
        continue;
      }
      if (op === 'sum') base[as] = nums.reduce((x, y) => x + y, 0);
      else if (op === 'avg') base[as] = nums.reduce((x, y) => x + y, 0) / nums.length;
      else if (op === 'min') base[as] = Math.min(...nums);
      else if (op === 'max') base[as] = Math.max(...nums);
      else base[as] = null;
    }
    outRows.push(base);
  }

  return outRows;
}

function sortAndLimit(rows, plan) {
  const out = rows.slice();
  const sort = plan?.sort && typeof plan.sort === 'object' ? plan.sort : null;
  if (sort && sort.by) {
    const by = String(sort.by);
    const dir = String(sort.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const av = a?.[by];
      const bv = b?.[by];
      const an = typeof av === 'number' ? av : parseNumberLoose(av);
      const bn = typeof bv === 'number' ? bv : parseNumberLoose(bv);
      if (an !== null && bn !== null) return (an - bn) * dir;
      return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }
  const limit = plan?.limit == null ? null : Number(plan.limit);
  if (Number.isFinite(limit) && limit > 0) return out.slice(0, Math.min(200, Math.trunc(limit)));
  return out.slice(0, 200);
}

async function runTableQuery({ tenantId, projectId, datasetVersion, allowedFilenames = [], query, trace = null }) {
  if (!systemSettings.getBoolean('TABLE_QUERY_ENABLED')) return { ok: false, skipped: true, reason: 'TABLE_QUERY_ENABLED is off' };

  const maxExecRows = Math.max(200, Math.min(Number(systemSettings.getNumber('TABLE_QUERY_EXEC_MAX_ROWS') || 12000), 50000));

  const filename = (query?.filename && allowedFilenames.includes(query.filename)) ? query.filename : null;
  const pickFilename =
    filename ||
    (allowedFilenames || []).find(n => /\.xls(x)?$/i.test(String(n || ''))) ||
    null;
  if (!pickFilename) return { ok: false, skipped: true, reason: 'no xlsx filename available' };

  const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename: pickFilename }).select('_id').lean();
  if (!fileDoc) return { ok: false, skipped: true, reason: 'dataset file not found' };

  const sheetWanted = query?.sheet ? String(query.sheet).trim() : '';

  const rowDocs = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, datasetFileId: fileDoc._id })
    .select('filename sheet rowIndex text')
    .limit(maxExecRows)
    .lean();

  const rows = [];
  for (const d of rowDocs || []) {
    const sheet = String(d?.sheet || '').trim();
    if (sheetWanted && sheetWanted.toLowerCase() !== sheet.toLowerCase()) continue;
    const obj = parseRowChunkText(d?.text);
    rows.push({ ...obj, __sheet: sheet, __rowIndex: Number(d?.rowIndex) });
  }

  const filtered = (Array.isArray(query?.filters) && query.filters.length)
    ? rows.filter(r => query.filters.every(f => applyFilter(r, f)))
    : rows;

  const aggregated = aggregateRows(filtered, query || {});
  let finalRows = [];
  if (aggregated) {
    finalRows = sortAndLimit(aggregated, query || {});
  } else {
    // Default mode: return raw rows (limited) if no aggregations/groupBy were specified.
    const limit = query?.limit == null ? 30 : Math.max(1, Math.min(200, Math.trunc(Number(query.limit) || 30)));
    const cols = Array.isArray(query?.returnColumns) && query.returnColumns.length
      ? query.returnColumns
      : (() => {
        const first = filtered[0] || {};
        return Object.keys(first).filter(k => !k.startsWith('__')).slice(0, 12);
      })();
    finalRows = filtered.slice(0, limit).map(r => {
      const out = {};
      for (const c of cols) {
        const real = resolveColumnName(r, c);
        out[c] = real ? r[real] : null;
      }
      out.__sheet = r.__sheet;
      out.__rowIndex = r.__rowIndex;
      return out;
    });
  }

  const result = {
    meta: {
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      filename: pickFilename,
      sheet: sheetWanted || null,
      rows_scanned: rows.length,
      rows_matched: filtered.length,
    },
    rows: finalRows,
  };

  try {
    logger.info('table.query.done', {
      requestId: trace?.requestId,
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      filename: pickFilename,
      sheet: sheetWanted || null,
      rows: rows.length,
      matched: filtered.length,
      out: finalRows.length,
    });
  } catch { }

  return { ok: true, result };
}

module.exports = {
  runTableQuery,
  __test: {
    parseRowChunkText,
    applyFilter,
    aggregateRows,
    sortAndLimit,
  }
};
