const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');

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

function simplifyKey(s) {
  return normalizeKey(s).replace(/[^a-z0-9]/g, '');
}

function resolveColumnNameFromList(columns, wantColumn) {
  const want = normalizeKey(wantColumn);
  if (!want) return null;
  const direct = columns.find(k => normalizeKey(k) === want);
  if (direct) return direct;
  const w2 = simplifyKey(want);
  if (!w2) return null;
  return columns.find(k => simplifyKey(k) === w2) || null;
}

function resolveColumnName(rowObj, wantColumn) {
  return resolveColumnNameFromList(Object.keys(rowObj || {}), wantColumn);
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

async function loadRows({ tenantId, projectId, datasetVersion, filename, sheet = null, maxRows = 12000 }) {
  const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename })
    .select('_id filename')
    .lean();
  if (!fileDoc?._id) return { ok: false, rows: [], columns: [] };

  const q = {
    tenantId,
    projectId,
    datasetVersion,
    datasetFileId: fileDoc._id,
  };
  if (sheet) q.sheet = sheet;

  const limit = Math.max(50, Math.min(Number(maxRows || 12000) * 6, 80000));
  const rows = await DatasetRowChunk.find(q)
    .select('sheet rowIndex text')
    .limit(limit)
    .lean();

  const sorted = (rows || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
  const slice = sorted.slice(0, Math.max(1, Number(maxRows || 12000)));
  const outRows = [];
  const colOrder = new Map();

  for (const r of slice) {
    const obj = parseRowChunkText(r?.text);
    outRows.push(obj);
    for (const k of Object.keys(obj)) {
      if (!colOrder.has(k)) colOrder.set(k, true);
    }
  }

  return {
    ok: true,
    filename: String(fileDoc.filename || filename),
    rows: outRows,
    columns: Array.from(colOrder.keys()),
  };
}

module.exports = {
  parseNumberLoose,
  parseRowChunkText,
  normalizeKey,
  simplifyKey,
  resolveColumnNameFromList,
  resolveColumnName,
  coerceComparable,
  applyFilter,
  loadRows,
};
