const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const DatasetTableCell = require('../models/datasetTableCell');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');

function enabled() {
  return systemSettings.getBoolean('MEAS_EVAL_ENABLED');
}

function parseCsvList(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function extractRowLabelFromRowText(rowText) {
  const s = String(rowText || '');
  // Prefer the first column header used by our ingestion for these measurement workbooks.
  const tryKeys = ['Parameters', 'Parameter', 'Name', '0', 'col_0'];
  for (const k of tryKeys) {
    const re = new RegExp(`\\b${k}=([^|\\n]+)`, 'i');
    const m = s.match(re);
    if (m && String(m[1] || '').trim()) return String(m[1]).trim();
  }
  // Fallback: after ROW_INDEX line, take the first "key=value" value.
  const body = s.split('\n').slice(3).join('\n');
  const m2 = body.match(/^[^=]+=([^|\n]+)/m);
  return m2 ? String(m2[1] || '').trim() : '';
}

function extractUnitFromRowText(rowText) {
  const s = String(rowText || '');
  const keys = ['Value', 'Unit', '1', 'col_1'];
  for (const k of keys) {
    const re = new RegExp(`\\b${k}=([^|\\n]+)`, 'i');
    const m = s.match(re);
    if (m && String(m[1] || '').trim()) return String(m[1]).trim();
  }
  return '';
}

function tokenFromLabel(labelOrRowText) {
  const label = extractRowLabelFromRowText(labelOrRowText) || String(labelOrRowText || '');
  const m = String(label || '').trim().match(/\b(T\d{1,2})\b/i);
  if (!m) return '';
  const token = m[1].toUpperCase();
  const n = Number(token.slice(1));
  const max = Math.max(5, Math.min(Number(systemSettings.getNumber('MEAS_POINT_MAX') || 25), 99));
  // Avoid false matches from sheet names like "T50"/"T55" etc.
  if (!Number.isInteger(n) || n <= 0 || n > max) return '';
  return token;
}

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
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

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 10) / 10;
}

function normalizeSupplyUnit(unitRaw) {
  const u = String(unitRaw || '').toUpperCase();
  if (u.includes('VAC')) return 'VAC';
  if (u.includes('VDC')) return 'VDC';
  if (u.includes('%')) return '%';
  return u || '';
}

function uniqueBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const it of arr || []) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function pickMaxCell(cells) {
  let best = null;
  for (const c of cells || []) {
    const v = Number(c?.valueNumber);
    if (!Number.isFinite(v)) continue;
    if (!best || v > Number(best.valueNumber)) best = c;
  }
  return best;
}

function pickMinCell(cells) {
  let best = null;
  for (const c of cells || []) {
    const v = Number(c?.valueNumber);
    if (!Number.isFinite(v)) continue;
    if (!best || v < Number(best.valueNumber)) best = c;
  }
  return best;
}

function toEvidenceCell(c) {
  return {
    kind: 'cell',
    fileName: String(c?.filename || ''),
    sheet: String(c?.sheet || ''),
    rowIndex: Number(c?.rowIndex),
    colIndex: Number(c?.colIndex),
    cell: String(c?.cell || ''),
    value: String(c?.valueRaw || ''),
  };
}

function toEvidenceComputed({ op, value, unit = '', sources = [] }) {
  return {
    kind: 'computed',
    op,
    value: String(value),
    unit: String(unit || ''),
    sources,
  };
}

function detectIntent(message) {
  const s = normalizeKey(message);
  const needles = [
    'risk assessment',
    'evaluate',
    'evaluation',
    'measurement',
    'excel',
    'xlsx',
    'max temperature',
    'max hőmérs',
    'mérési adatok',
    'kiértékel',
    'hőmérséklet',
    't70',
    't4',
    'steady',
    '300',
  ];
  return needles.some(n => s.includes(n));
}

function detectCompareTablesIntent(message) {
  const s = normalizeKey(message);
  // Examples:
  // "comparative analysis of Table 1 to Table 4 ... columns C to K"
  // "Compare Table 1-4"
  const hasCompare =
    s.includes('compare') ||
    s.includes('comparative') ||
    s.includes('különbs') ||
    s.includes('kulonbs') ||
    s.includes('összevet') ||
    s.includes('osszevet') ||
    s.includes('összehasonl') ||
    s.includes('osszehasonl');
  const hasTables = /table\s*1/i.test(message) && /table\s*4/i.test(message);
  const hasCols = /col(umn)?s?\s*c\s*(to|–|-)\s*k/i.test(message) || /\bc\s*(to|–|-)\s*k\b/i.test(message);
  return hasCompare && (hasTables || /table\s*1\s*(to|–|-)\s*4/i.test(message)) && hasCols;
}

function colLetterToIndex(letter) {
  const s = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n; // 1-based
}

function parseColumnRangeFromMessage(message) {
  const m = String(message || '').match(/\b([A-K])\s*(?:to|–|-)\s*([A-K])\b/i);
  if (!m) return { from: 3, to: 11, label: 'C–K' };
  const a = colLetterToIndex(m[1]);
  const b = colLetterToIndex(m[2]);
  if (!a || !b) return { from: 3, to: 11, label: 'C–K' };
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return { from, to, label: `${m[1].toUpperCase()}–${m[2].toUpperCase()}` };
}

function inferTableSemantics({ tablesMeta }) {
  // tablesMeta: [{ tableNo, supply: {value, unitNorm}, anomalies[] }]
  const out = new Map(); // tableNo -> { supplyType, nominalOrHigh, label }

  const byType = { VAC: [], VDC: [] };
  for (const t of tablesMeta || []) {
    const unitNorm = t?.supply?.unitNorm;
    const v = Number(t?.supply?.value);
    if ((unitNorm === 'VAC' || unitNorm === 'VDC') && Number.isFinite(v)) {
      byType[unitNorm].push({ tableNo: t.tableNo, v });
    }
  }
  for (const typ of ['VAC', 'VDC']) {
    const items = byType[typ].slice().sort((a, b) => a.v - b.v);
    if (items.length >= 2) {
      out.set(items[0].tableNo, { supplyType: typ, nominalOrHigh: 'NOMINAL', label: typ === 'VAC' ? 'AC nominal' : 'DC nominal' });
      out.set(items[items.length - 1].tableNo, { supplyType: typ, nominalOrHigh: 'HIGH', label: typ === 'VAC' ? 'AC high (worst-case)' : 'DC high (worst-case)' });
      // middle ones (if ever) left unknown.
      for (const mid of items.slice(1, -1)) {
        out.set(mid.tableNo, { supplyType: typ, nominalOrHigh: 'UNKNOWN', label: typ });
      }
    } else if (items.length === 1) {
      out.set(items[0].tableNo, { supplyType: typ, nominalOrHigh: 'UNKNOWN', label: typ === 'VAC' ? 'AC (unknown nominal/high)' : 'DC (unknown nominal/high)' });
    }
  }

  return out;
}

function lastNCols(cols, n) {
  const c = (cols || []).slice().sort((a, b) => a - b);
  if (!c.length) return [];
  return c.slice(Math.max(0, c.length - Math.max(1, n)));
}

function avgOfCells(cells) {
  const nums = (cells || []).map(c => Number(c?.valueNumber)).filter(v => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pickCellByCol(cells, colIndex) {
  const want = Number(colIndex);
  for (const c of cells || []) {
    if (Number(c?.colIndex) === want && Number.isFinite(Number(c?.valueNumber))) return c;
  }
  return null;
}

async function evaluateXlsxMeasurements({ tenantId, projectId, datasetVersion, allowedFilenames = [], trace = null }) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'MEAS_EVAL_ENABLED is off' };

  const maxFiles = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_FILES') || 3), 10));
  const maxTablesPerSheet = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_TABLES') || 8), 30));
  const maxSheets = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_SHEETS') || 12), 30));
  const extPoints = parseCsvList(systemSettings.getString('MEAS_EXT_POINTS') || 'T10,T11,T4').map(s => s.toUpperCase());

  const limits = {
    gas_T4_C: Number(systemSettings.getString('MEAS_LIMIT_GAS_T4_C') || '') || null,
    dust_surface_C: Number(systemSettings.getString('MEAS_LIMIT_DUST_SURFACE_C') || '') || null,
  };

  const xlsxFiles = (allowedFilenames || [])
    .filter(n => String(n).toLowerCase().endsWith('.xlsx') || String(n).toLowerCase().endsWith('.xls'))
    .slice(0, maxFiles);

  if (!xlsxFiles.length) return { ok: false, skipped: true, reason: 'no xlsx in allowedFilenames' };

  const result = {
    meta: {
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      external_points: extPoints,
      limits,
      notes: [
        'This evaluation is deterministic from XLSX cells stored in the dataset.',
        'All numbers must be cited via numericEvidence (cell or computed) for full compliance answers.',
      ],
    },
    by_test: [],
    worst_by_point: [],
    numericEvidence: [],
  };

  const worst = new Map(); // token -> { maxCell, sheet, tableNo, supply, unit }

  for (const filename of xlsxFiles) {
    const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename }).select('_id').lean();
    if (!fileDoc) continue;
    const datasetFileId = fileDoc._id;

    // Load all row chunks for the workbook file (bounded), group by sheet.
    const rows = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, datasetFileId })
      .select('filename sheet rowIndex text')
      .limit(20000)
      .lean();

    const bySheet = new Map();
    for (const r of rows) {
      const sh = String(r?.sheet || '').trim();
      if (!sh) continue;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      bySheet.get(sh).push(r);
    }

    const sheetNames = Array.from(bySheet.keys()).slice(0, maxSheets);
    for (const sheet of sheetNames) {
      const sheetRows = (bySheet.get(sheet) || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
      if (!sheetRows.length) continue;

      // Find "Table N" markers by scanning row text.
      const tables = [];
      for (const r of sheetRows) {
        const t = String(r?.text || '');
        const m = t.match(/\bTable\s+(\d+)\b/i);
        if (!m) continue;
        const n = Number(m[1]);
        if (!Number.isInteger(n) || n <= 0) continue;
        tables.push({ tableNo: n, startRow: Number(r.rowIndex) });
      }
      tables.sort((a, b) => a.startRow - b.startRow);
      const unique = [];
      const seen = new Set();
      for (const t of tables) {
        const k = `${t.tableNo}:${t.startRow}`;
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(t);
      }
      const selectedTables = unique.slice(0, maxTablesPerSheet);
      if (!selectedTables.length) continue;

      for (let ti = 0; ti < selectedTables.length; ti += 1) {
        const tableNo = selectedTables[ti].tableNo;
        const startRow = selectedTables[ti].startRow;
        const endRow = (selectedTables[ti + 1] ? selectedTables[ti + 1].startRow : (startRow + 400));

        // Find time row (first row after startRow that contains "Time").
        const timeRow = sheetRows.find(r => Number(r.rowIndex) > startRow && Number(r.rowIndex) < endRow && /(^|\b)Time\b/i.test(String(r.text || '')));
        if (!timeRow) continue;

        const timeRowIndex = Number(timeRow.rowIndex);
        const timeCells = await DatasetTableCell.find({
          tenantId,
          projectId,
          datasetVersion,
          datasetFileId,
          filename,
          sheet,
          rowIndex: timeRowIndex,
        })
          .select('filename sheet rowIndex colIndex cell valueRaw valueNumber')
          .lean();

        // Determine time columns: numeric values (minutes) >=0; choose columns with the widest coverage.
        const timeCols = (timeCells || [])
          .filter(c => Number.isFinite(c.valueNumber))
          .filter(c => Number(c.valueNumber) >= 0 && Number(c.valueNumber) <= 100000)
          .sort((a, b) => Number(a.colIndex) - Number(b.colIndex));
        if (!timeCols.length) continue;

        const firstTimeCol = Number(timeCols[0].colIndex);
        const lastTimeCol = Number(timeCols.slice().sort((a, b) => Number(b.valueNumber) - Number(a.valueNumber))[0].colIndex);
        const timeColIndices = timeCols.map(c => Number(c.colIndex));

        // Series rows: following rows with Tn and temperature unit.
        const seriesRows = sheetRows
          .filter(r => Number(r.rowIndex) > timeRowIndex && Number(r.rowIndex) < endRow)
          .filter(r => tokenFromLabel(r.text))
          .filter(r => {
            const unit = extractUnitFromRowText(r.text);
            if (unit && (unit.includes('°C') || unit.includes('[°C]') || /[°º]\s*c/i.test(unit))) return true;
            // fallback label heuristic
            const lbl = extractRowLabelFromRowText(r.text).toLowerCase();
            return !!lbl && (lbl.includes('temperature') || lbl.includes('hőm') || lbl.includes('driver') || lbl.includes('ambient') || lbl.includes('outside') || lbl.includes('cable gland'));
          })
          .slice(0, 64);
        if (!seriesRows.length) continue;

        // Meta rows within the table block
        const metaKeys = ['supply voltage', 'humidity', 'power', 'through current'];
        const meta = {};
        const metaEvidence = {};
        for (const r of sheetRows.filter(x => Number(x.rowIndex) > timeRowIndex && Number(x.rowIndex) < endRow).slice(0, 120)) {
          const txt = normalizeKey(extractRowLabelFromRowText(r.text) || r.text);
          const key = metaKeys.find(k => txt.includes(k));
          if (!key) continue;
          const rowIndex = Number(r.rowIndex);
          const c = await DatasetTableCell.findOne({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex,
            colIndex: firstTimeCol,
          }).select('filename sheet rowIndex colIndex cell valueRaw valueNumber').lean();
          if (!c || !Number.isFinite(c.valueNumber)) continue;
          meta[key] = Number(c.valueNumber);
          metaEvidence[key] = toEvidenceCell({ ...c, filename, sheet });
        }

        // anomaly fix (humidity/supply swapped)
        if (Number.isFinite(meta['humidity']) && Number.isFinite(meta['supply voltage'])) {
          if (meta['humidity'] > 100 && meta['supply voltage'] <= 100) {
            const tmp = meta['humidity'];
            meta['humidity'] = meta['supply voltage'];
            meta['supply voltage'] = tmp;
            const tmpEv = metaEvidence['humidity'];
            metaEvidence['humidity'] = metaEvidence['supply voltage'];
            metaEvidence['supply voltage'] = tmpEv;
          }
        }

        const points = [];
        let hottest = null;
        let externalMax = null;

        for (const sr of seriesRows) {
          const label = extractRowLabelFromRowText(sr.text) || String(sr.text || '').trim();
          const token = tokenFromLabel(sr.text);
          if (!token) continue;

          const rowIndex = Number(sr.rowIndex);
          const cells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex,
            colIndex: { $in: timeColIndices },
          }).select('filename sheet rowIndex colIndex cell valueRaw valueNumber').lean();

          const maxCell = pickMaxCell(cells);
          const lastCell = cells.find(c => Number(c.colIndex) === lastTimeCol) || null;
          if (!maxCell) continue;

          const item = {
            point: token,
            label,
            max: {
              value: Number(maxCell.valueNumber),
              cell: toEvidenceCell({ ...maxCell, filename, sheet }),
            },
            steady: lastCell && Number.isFinite(lastCell.valueNumber)
              ? { value: Number(lastCell.valueNumber), cell: toEvidenceCell({ ...lastCell, filename, sheet }) }
              : null,
          };
          points.push(item);

          if (!hottest || item.max.value > hottest.max.value) hottest = item;
          if (extPoints.includes(token)) {
            if (!externalMax || item.max.value > externalMax.max.value) externalMax = item;
          }

          const w = worst.get(token);
          if (!w || item.max.value > w.max.value) {
            worst.set(token, { ...item, sheet, tableNo, supply: meta['supply voltage'] ?? null });
          }
        }

        if (!hottest) continue;

        // collect evidence (only for summary-level numbers to keep JSON small)
        const evid = [];
        evid.push(hottest.max.cell);
        if (hottest.steady?.cell) evid.push(hottest.steady.cell);
        if (externalMax?.max?.cell) evid.push(externalMax.max.cell);
        if (metaEvidence['supply voltage']) evid.push(metaEvidence['supply voltage']);
        if (metaEvidence['humidity']) evid.push(metaEvidence['humidity']);
        if (metaEvidence['power']) evid.push(metaEvidence['power']);
        if (metaEvidence['through current']) evid.push(metaEvidence['through current']);
        result.numericEvidence.push(...evid);

        // computed delta: hottest.max - hottest.steady (if steady exists)
        let delta = null;
        if (hottest.steady && Number.isFinite(hottest.steady.value)) {
          const d = Number(hottest.max.value) - Number(hottest.steady.value);
          delta = {
            value: d,
            evidence: toEvidenceComputed({
              op: 'delta',
              value: d,
              unit: '°C',
              sources: [hottest.max.cell, hottest.steady.cell],
            })
          };
          result.numericEvidence.push(delta.evidence);
        }

        result.by_test.push({
          fileName: filename,
          sheet,
          table: tableNo,
          time: {
            last_min: Number(timeCols.slice().sort((a, b) => Number(b.valueNumber) - Number(a.valueNumber))[0].valueNumber),
            last_cell: toEvidenceCell({ ...timeCols.slice().sort((a, b) => Number(b.valueNumber) - Number(a.valueNumber))[0], filename, sheet }),
          },
          supply: meta['supply voltage'] !== undefined ? { value: meta['supply voltage'], evidence: metaEvidence['supply voltage'] } : null,
          humidity: meta['humidity'] !== undefined ? { value: meta['humidity'], evidence: metaEvidence['humidity'] } : null,
          power: meta['power'] !== undefined ? { value: meta['power'], evidence: metaEvidence['power'] } : null,
          hottest: { point: hottest.point, max_C: hottest.max.value, evidence: hottest.max.cell },
          external_max: externalMax ? { point: externalMax.point, max_C: externalMax.max.value, evidence: externalMax.max.cell } : null,
          delta_max_minus_steady: delta ? { value_C: delta.value, evidence: delta.evidence } : null,
          points: points.slice(0, 24).map(p => ({ point: p.point, max_C: p.max.value, steady_C: p.steady ? p.steady.value : null })),
        });
      }
    }
  }

  // Worst by point summary
  for (const [token, item] of worst.entries()) {
    result.worst_by_point.push({
      point: token,
      max_C: item.max.value,
      fileName: String(item?.max?.cell?.fileName || ''),
      sheet: String(item?.sheet || ''),
      table: Number(item?.tableNo || 0) || null,
      supply: item.supply ?? null,
      evidence: item.max.cell,
    });
    result.numericEvidence.push(item.max.cell);
  }
  result.worst_by_point.sort((a, b) => Number(b.max_C) - Number(a.max_C));
  result.numericEvidence = result.numericEvidence.slice(0, 250);

  try {
    logger.info('meas.eval.done', {
      requestId: trace?.requestId,
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      files: xlsxFiles.length,
      tests: result.by_test.length,
      worstPoints: result.worst_by_point.length,
    });
  } catch { }

  return { ok: true, result };
}

async function analyzeMeasurementTables({ tenantId, projectId, datasetVersion, allowedFilenames = [], message = '', options = null, trace = null }) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'MEAS_EVAL_ENABLED is off' };

  const maxFiles = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_FILES') || 3), 10));
  const maxSheets = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_SHEETS') || 12), 30));
  const lastN = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_STEADY_LAST_N') || 3), 10));

  const thresholds = {
    noise_C: Number(systemSettings.getNumber('MEAS_DIFF_NOISE_C') || 2) || 2,
    noteworthy_C: Number(systemSettings.getNumber('MEAS_DIFF_NOTE_C') || 3) || 3,
    critical_C: Number(systemSettings.getNumber('MEAS_DIFF_CRITICAL_C') || 5) || 5,
  };

  const colHint = String(options?.column_range || options?.columns || '').trim();
  const { from: colFrom, to: colTo, label: colLabel } = colHint ? parseColumnRangeFromMessage(colHint) : parseColumnRangeFromMessage(message);
  const reqCols = [];
  for (let c = colFrom; c <= colTo; c += 1) reqCols.push(c);

  const xlsxFiles = (allowedFilenames || [])
    .filter(n => String(n).toLowerCase().endsWith('.xlsx') || String(n).toLowerCase().endsWith('.xls'))
    .slice(0, maxFiles);
  if (!xlsxFiles.length) return { ok: false, skipped: true, reason: 'no xlsx in allowedFilenames' };

  const out = {
    meta: {
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      tables: [1, 2, 3, 4],
      requestedColumns: colLabel,
      thresholds_C: thresholds,
      steady_last_n: lastN,
      notes: [
        'Deterministic engineering-style analysis for Table 1..4 comparisons.',
        'Table semantics are inferred from per-table supply voltage rows when available.',
      ],
    },
    by_sheet: [],
    numericEvidence: [],
  };

  for (const filename of xlsxFiles) {
    const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename }).select('_id').lean();
    if (!fileDoc) continue;
    const datasetFileId = fileDoc._id;

    const rows = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, datasetFileId })
      .select('filename sheet rowIndex text')
      .limit(22000)
      .lean();

    const bySheet = new Map();
    for (const r of rows) {
      const sh = String(r?.sheet || '').trim();
      if (!sh) continue;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      bySheet.get(sh).push(r);
    }

    const sheetNames = Array.from(bySheet.keys()).slice(0, maxSheets);
    for (const sheet of sheetNames) {
      const sheetRows = (bySheet.get(sheet) || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
      if (!sheetRows.length) continue;

      const tables = [];
      for (const r of sheetRows) {
        const m = String(r?.text || '').match(/\bTable\s+(\d+)\b/i);
        if (!m) continue;
        const n = Number(m[1]);
        if (![1, 2, 3, 4].includes(n)) continue;
        tables.push({ tableNo: n, startRow: Number(r.rowIndex) });
      }
      const selectedTables = uniqueBy(tables.sort((a, b) => a.startRow - b.startRow), t => `${t.tableNo}:${t.startRow}`).slice(0, 4);
      if (!selectedTables.length) continue;

      const perTablePoints = new Map(); // tableNo -> Map(token -> { label, rowIndex, steadyEnd, steadyMaxLastN, steadyAvgLastN, peakMax })
      const perTableMeta = new Map(); // tableNo -> { supply, humidity, power, anomalies[], columnsUsedLabel }

      for (let ti = 0; ti < selectedTables.length; ti += 1) {
        const tableNo = selectedTables[ti].tableNo;
        const startRow = selectedTables[ti].startRow;
        const endRow = (selectedTables[ti + 1] ? selectedTables[ti + 1].startRow : (startRow + 520));

        const timeRow = sheetRows.find(r => Number(r.rowIndex) > startRow && Number(r.rowIndex) < endRow && /(^|\b)Time\b/i.test(String(r.text || '')));
        if (!timeRow) continue;
        const timeRowIndex = Number(timeRow.rowIndex);

        // Determine usable columns based on the Time row (then intersect with requested range).
        let usedCols = reqCols.slice();
        try {
          const timeCells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex: timeRowIndex,
          }).select('colIndex valueNumber').lean();
          const timeCols = (timeCells || [])
            .filter(c => Number.isFinite(c.valueNumber))
            .filter(c => Number(c.valueNumber) >= 0 && Number(c.valueNumber) <= 100000)
            .map(c => Number(c.colIndex));
          const intersection = timeCols.filter(c => c >= colFrom && c <= colTo).sort((a, b) => a - b);
          if (intersection.length) usedCols = intersection;
        } catch { }

        const usedLabel = `${String.fromCharCode(64 + Math.min(...usedCols))}–${String.fromCharCode(64 + Math.max(...usedCols))}`;

        // Series rows
        const seriesRows = sheetRows
          .filter(r => Number(r.rowIndex) > timeRowIndex && Number(r.rowIndex) < endRow)
          .filter(r => tokenFromLabel(r.text))
          .filter(r => {
            const unit = extractUnitFromRowText(r.text);
            if (unit && (unit.includes('°C') || unit.includes('[°C]') || /[°º]\s*c/i.test(unit))) return true;
            const lbl = extractRowLabelFromRowText(r.text).toLowerCase();
            return !!lbl && (lbl.includes('temperature') || lbl.includes('hőm') || lbl.includes('driver') || lbl.includes('ambient') || lbl.includes('outside') || lbl.includes('cable gland') || lbl.includes('terminal'));
          })
          .slice(0, 90);
        if (!seriesRows.length) continue;

        const seriesRowIndices = Array.from(new Set(seriesRows.map(r => Number(r.rowIndex)).filter(n => Number.isFinite(n))));
        const allCells = await DatasetTableCell.find({
          tenantId,
          projectId,
          datasetVersion,
          datasetFileId,
          filename,
          sheet,
          rowIndex: { $in: seriesRowIndices },
          colIndex: { $in: usedCols },
        }).select('rowIndex colIndex cell valueRaw valueNumber').lean();

        const byRow = new Map();
        for (const c of allCells || []) {
          const ri = Number(c?.rowIndex);
          if (!byRow.has(ri)) byRow.set(ri, []);
          byRow.get(ri).push(c);
        }

        const lastCols = lastNCols(usedCols, lastN);
        const pointsMap = new Map();
        for (const sr of seriesRows) {
          const token = tokenFromLabel(sr.text);
          if (!token) continue;
          const label = extractRowLabelFromRowText(sr.text) || String(sr.text || '').trim();
          const rowIndex = Number(sr.rowIndex);
          const cells = (byRow.get(rowIndex) || []).filter(c => Number.isFinite(Number(c.valueNumber)));
          if (!cells.length) continue;

          const peak = pickMaxCell(cells);
          const endCell = pickCellByCol(cells, Math.max(...usedCols)) || peak;
          const lastCells = lastCols.map(ci => pickCellByCol(cells, ci)).filter(Boolean);
          const lastMaxCell = pickMaxCell(lastCells) || endCell;
          const lastAvg = avgOfCells(lastCells);

          const steadyAvgEv = (lastCells.length && lastAvg !== null)
            ? toEvidenceComputed({
              op: 'avg',
              value: round1(lastAvg),
              unit: '°C',
              sources: lastCells.map(c => toEvidenceCell({ ...c, filename, sheet })),
            })
            : null;
          if (steadyAvgEv) out.numericEvidence.push(steadyAvgEv);

          pointsMap.set(token, {
            token,
            label,
            rowIndex,
            peak_max_C: round1(peak.valueNumber),
            peak_max_evidence: toEvidenceCell({ ...peak, filename, sheet }),
            steady_end_C: round1(endCell.valueNumber),
            steady_end_evidence: toEvidenceCell({ ...endCell, filename, sheet }),
            steady_max_lastN_C: round1(lastMaxCell.valueNumber),
            steady_max_lastN_evidence: toEvidenceCell({ ...lastMaxCell, filename, sheet }),
            steady_avg_lastN_C: steadyAvgEv ? round1(lastAvg) : null,
            steady_avg_lastN_evidence: steadyAvgEv,
            usedCols: { from: Math.min(...usedCols), to: Math.max(...usedCols), label: usedLabel, lastN: lastCols },
          });

          for (const ev of [peak, endCell, lastMaxCell]) out.numericEvidence.push(toEvidenceCell({ ...ev, filename, sheet }));
        }
        perTablePoints.set(tableNo, pointsMap);

        // Meta rows
        const firstCol = usedCols.length ? Number(usedCols[0]) : colFrom;
        const metaKeys = ['supply voltage', 'humidity', 'power'];
        const meta = {};
        const metaEvidence = {};
        const metaUnits = {};
        const anomalies = [];

        const metaRows = sheetRows
          .filter(r => Number(r.rowIndex) > timeRowIndex && Number(r.rowIndex) < endRow)
          .slice(0, 160)
          .map(r => {
            const lbl = normalizeKey(extractRowLabelFromRowText(r.text) || r.text);
            const hit = metaKeys.find(k => lbl.includes(k));
            return hit ? { key: hit, rowIndex: Number(r.rowIndex), unit: extractUnitFromRowText(r.text) } : null;
          })
          .filter(Boolean);
        const wanted = new Map();
        for (const mr of metaRows) if (!wanted.has(mr.key)) wanted.set(mr.key, mr);

        const wantedList = Array.from(wanted.values());
        if (wantedList.length) {
          const wantedRowIndices = wantedList.map(x => Number(x.rowIndex));
          const metaCells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex: { $in: wantedRowIndices },
            colIndex: firstCol,
          }).select('rowIndex colIndex cell valueRaw valueNumber').lean();

          const byMetaRow = new Map();
          for (const c of metaCells || []) byMetaRow.set(Number(c.rowIndex), c);

          for (const mr of wantedList) {
            const c = byMetaRow.get(Number(mr.rowIndex));
            if (!c || !Number.isFinite(c.valueNumber)) continue;
            meta[mr.key] = Number(c.valueNumber);
            metaUnits[mr.key] = String(mr.unit || '');
            metaEvidence[mr.key] = toEvidenceCell({ ...c, filename, sheet });
          }
        }

        // anomaly fix (humidity/supply swapped)
        if (Number.isFinite(meta['humidity']) && Number.isFinite(meta['supply voltage'])) {
          if (meta['humidity'] > 100 && meta['supply voltage'] <= 100) {
            anomalies.push('swap_supply_humidity');
            [meta['humidity'], meta['supply voltage']] = [meta['supply voltage'], meta['humidity']];
            [metaUnits['humidity'], metaUnits['supply voltage']] = [metaUnits['supply voltage'], metaUnits['humidity']];
            [metaEvidence['humidity'], metaEvidence['supply voltage']] = [metaEvidence['supply voltage'], metaEvidence['humidity']];
          }
        }

        const supplyUnitNorm = normalizeSupplyUnit(metaUnits['supply voltage'] || '');
        perTableMeta.set(tableNo, {
          tableNo,
          columnsUsed: usedLabel,
          supply: meta['supply voltage'] !== undefined
            ? { value: round1(meta['supply voltage']), unitRaw: metaUnits['supply voltage'] || '', unitNorm: supplyUnitNorm, evidence: metaEvidence['supply voltage'] || null }
            : null,
          humidity: meta['humidity'] !== undefined ? { value: round1(meta['humidity']), unitRaw: metaUnits['humidity'] || '', evidence: metaEvidence['humidity'] || null } : null,
          power: meta['power'] !== undefined ? { value: round1(meta['power']), unitRaw: metaUnits['power'] || '', evidence: metaEvidence['power'] || null } : null,
          anomalies,
        });
        for (const k of ['supply voltage', 'humidity', 'power']) if (metaEvidence[k]) out.numericEvidence.push(metaEvidence[k]);
      }

      if (!perTablePoints.size) continue;

      const tablesMetaArr = Array.from(perTableMeta.values());
      const inferred = inferTableSemantics({
        tablesMeta: tablesMetaArr.map(t => ({
          tableNo: t.tableNo,
          supply: t.supply ? { value: t.supply.value, unitNorm: t.supply.unitNorm } : null,
          anomalies: t.anomalies || [],
        })),
      });

      // Build per-point comparative stats.
      const allTokens = new Set();
      for (const m of perTablePoints.values()) for (const t of m.keys()) allTokens.add(t);
      const tokenList = Array.from(allTokens).sort((a, b) => (Number(a.slice(1)) || 0) - (Number(b.slice(1)) || 0));

      const points = [];
      const highlights = { within_vac: [], within_vdc: [], spread_all: [], hottest_points: [] };

      for (const token of tokenList.slice(0, 25)) {
        const t1 = perTablePoints.get(1)?.get(token) || null;
        const t2 = perTablePoints.get(2)?.get(token) || null;
        const t3 = perTablePoints.get(3)?.get(token) || null;
        const t4 = perTablePoints.get(4)?.get(token) || null;

        const metricKey = 'steady_max_lastN_C'; // default
        const take = (x) => (x && Number.isFinite(Number(x[metricKey])) ? Number(x[metricKey]) : null);
        const vals = [
          { table: 1, v: take(t1), ev: t1?.steady_max_lastN_evidence || null, supply: perTableMeta.get(1)?.supply || null, inferred: inferred.get(1) || null },
          { table: 2, v: take(t2), ev: t2?.steady_max_lastN_evidence || null, supply: perTableMeta.get(2)?.supply || null, inferred: inferred.get(2) || null },
          { table: 3, v: take(t3), ev: t3?.steady_max_lastN_evidence || null, supply: perTableMeta.get(3)?.supply || null, inferred: inferred.get(3) || null },
          { table: 4, v: take(t4), ev: t4?.steady_max_lastN_evidence || null, supply: perTableMeta.get(4)?.supply || null, inferred: inferred.get(4) || null },
        ].filter(x => Number.isFinite(x.v));

        const row = {
          point: token,
          label: t1?.label || t2?.label || t3?.label || t4?.label || '',
          metric: { key: metricKey, description: `max of last ${lastN} time columns in ${colLabel}` },
          by_table: vals.map(x => ({
            table: x.table,
            condition: inferred.get(x.table)?.label || null,
            supply: x.supply || null,
            value_C: round1(x.v),
            evidence: x.ev,
          })),
          spread_all_C: null,
          significance: null,
        };

        if (vals.length >= 2) {
          const min = vals.slice().sort((a, b) => a.v - b.v)[0];
          const max = vals.slice().sort((a, b) => b.v - a.v)[0];
          const spread = max.v - min.v;
          row.spread_all_C = round1(spread);
          if (Math.abs(spread) >= thresholds.critical_C) row.significance = 'CRITICAL';
          else if (Math.abs(spread) >= thresholds.noteworthy_C) row.significance = 'NOTEWORTHY';
          else row.significance = 'NOISE';

          if (row.significance !== 'NOISE') {
            const ev = toEvidenceComputed({ op: 'range', value: round1(spread), unit: '°C', sources: [max.ev, min.ev].filter(Boolean) });
            out.numericEvidence.push(ev);
            highlights.spread_all.push({ point: token, spread_C: round1(spread), min: { table: min.table, value_C: round1(min.v), evidence: min.ev }, max: { table: max.table, value_C: round1(max.v), evidence: max.ev }, evidence: ev });
          }
        }

        // within supply comparisons if we have VAC/VDC inferred in canonical slots
        const t1s = vals.find(v => v.table === 1);
        const t2s = vals.find(v => v.table === 2);
        const t3s = vals.find(v => v.table === 3);
        const t4s = vals.find(v => v.table === 4);

        const s1 = perTableMeta.get(1)?.supply?.unitNorm;
        const s2 = perTableMeta.get(2)?.supply?.unitNorm;
        const s3 = perTableMeta.get(3)?.supply?.unitNorm;
        const s4 = perTableMeta.get(4)?.supply?.unitNorm;

        if (t1s && t2s && s1 === 'VAC' && s2 === 'VAC') {
          const d = t2s.v - t1s.v;
          if (Math.abs(d) >= thresholds.noteworthy_C) {
            const ev = toEvidenceComputed({ op: 'delta', value: round1(d), unit: '°C', sources: [t2s.ev, t1s.ev].filter(Boolean) });
            out.numericEvidence.push(ev);
            highlights.within_vac.push({ point: token, delta_C: round1(d), compare: 'Table2 - Table1 (VAC)', evidence: ev });
          }
        }
        if (t3s && t4s && s3 === 'VDC' && s4 === 'VDC') {
          const d = t4s.v - t3s.v;
          if (Math.abs(d) >= thresholds.noteworthy_C) {
            const ev = toEvidenceComputed({ op: 'delta', value: round1(d), unit: '°C', sources: [t4s.ev, t3s.ev].filter(Boolean) });
            out.numericEvidence.push(ev);
            highlights.within_vdc.push({ point: token, delta_C: round1(d), compare: 'Table4 - Table3 (VDC)', evidence: ev });
          }
        }

        points.push(row);
      }

      // Hottest points per table (engineering sense-check)
      const hottest = [];
      for (const [tableNo, m] of perTablePoints.entries()) {
        const arr = Array.from(m.values())
          .map(p => ({ point: p.token, value_C: Number(p.steady_max_lastN_C), evidence: p.steady_max_lastN_evidence }))
          .filter(x => Number.isFinite(x.value_C))
          .sort((a, b) => b.value_C - a.value_C)
          .slice(0, 5)
          .map(x => ({ ...x, value_C: round1(x.value_C), table: tableNo, condition: inferred.get(tableNo)?.label || null }));
        hottest.push(...arr);
      }
      hottest.sort((a, b) => b.value_C - a.value_C);
      highlights.hottest_points = hottest.slice(0, 12);

      // Trim highlight lists
      highlights.spread_all.sort((a, b) => Math.abs(Number(b.spread_C)) - Math.abs(Number(a.spread_C)));
      highlights.within_vac.sort((a, b) => Math.abs(Number(b.delta_C)) - Math.abs(Number(a.delta_C)));
      highlights.within_vdc.sort((a, b) => Math.abs(Number(b.delta_C)) - Math.abs(Number(a.delta_C)));
      highlights.spread_all = highlights.spread_all.slice(0, 25);
      highlights.within_vac = highlights.within_vac.slice(0, 20);
      highlights.within_vdc = highlights.within_vdc.slice(0, 20);

      out.by_sheet.push({
        fileName: filename,
        sheet,
        interpretation: {
          columnsUsedNote: 'C–K is treated as a time series segment; steady-state is approximated from the last N columns.',
          inferredTableMapping: [1, 2, 3, 4].map(n => ({
            table: n,
            inferred: inferred.get(n) || null,
            supply: perTableMeta.get(n)?.supply || null,
            anomalies: perTableMeta.get(n)?.anomalies || [],
            columnsUsed: perTableMeta.get(n)?.columnsUsed || colLabel,
          })),
        },
        points: points.slice(0, 25),
        highlights,
      });
    }
  }

  out.numericEvidence = out.numericEvidence.slice(0, 550);
  try {
    logger.info('meas.analyze.done', { requestId: trace?.requestId, projectId: String(projectId), datasetVersion: Number(datasetVersion), sheets: out.by_sheet.length });
  } catch { }
  return { ok: true, result: out };
}

async function compareTablesColumns({ tenantId, projectId, datasetVersion, allowedFilenames = [], message = '', options = null, trace = null }) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'MEAS_EVAL_ENABLED is off' };

  const maxFiles = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_FILES') || 3), 10));
  const maxSheets = Math.max(1, Math.min(Number(systemSettings.getNumber('MEAS_EVAL_MAX_SHEETS') || 12), 30));
  const maxTablesPerSheet = 4; // Table 1..4
  const deltaThreshold =
    Number(options?.delta_threshold_C ?? options?.deltaThreshold_C ?? systemSettings.getNumber('MEAS_COMPARE_DELTA_C') ?? 3) || 3;

  const colHint = String(options?.column_range || options?.columns || '').trim();
  const { from: colFrom, to: colTo, label: colLabel } = colHint ? parseColumnRangeFromMessage(colHint) : parseColumnRangeFromMessage(message);
  const colIndices = [];
  for (let c = colFrom; c <= colTo; c += 1) colIndices.push(c);

  const xlsxFiles = (allowedFilenames || [])
    .filter(n => String(n).toLowerCase().endsWith('.xlsx') || String(n).toLowerCase().endsWith('.xls'))
    .slice(0, maxFiles);
  if (!xlsxFiles.length) return { ok: false, skipped: true, reason: 'no xlsx in allowedFilenames' };

  const out = {
    meta: {
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      tables: [1, 2, 3, 4],
      columns: colLabel,
      colIndexRange: { from: colFrom, to: colTo },
      deltaThreshold_C: deltaThreshold,
      notes: [
        'Deterministic comparison from XLSX cells stored in the dataset.',
        'Comparisons across tables may reflect different test conditions (e.g. VAC vs VDC).',
        'All reported numbers are backed by numericEvidence cell refs (or computed refs).',
      ],
    },
    by_sheet: [],
    numericEvidence: [],
  };

  for (const filename of xlsxFiles) {
    const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename }).select('_id').lean();
    if (!fileDoc) continue;
    const datasetFileId = fileDoc._id;

    const rows = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, datasetFileId })
      .select('filename sheet rowIndex text')
      .limit(20000)
      .lean();

    const bySheet = new Map();
    for (const r of rows) {
      const sh = String(r?.sheet || '').trim();
      if (!sh) continue;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      bySheet.get(sh).push(r);
    }

    const sheetNames = Array.from(bySheet.keys()).slice(0, maxSheets);
    for (const sheet of sheetNames) {
      const sheetRows = (bySheet.get(sheet) || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
      if (!sheetRows.length) continue;

      // Identify Table 1..4 blocks
      const tables = [];
      for (const r of sheetRows) {
        const t = String(r?.text || '');
        const m = t.match(/\bTable\s+(\d+)\b/i);
        if (!m) continue;
        const n = Number(m[1]);
        if (![1, 2, 3, 4].includes(n)) continue;
        tables.push({ tableNo: n, startRow: Number(r.rowIndex) });
      }
      tables.sort((a, b) => a.startRow - b.startRow);
      const selectedTables = tables.slice(0, maxTablesPerSheet);
      if (!selectedTables.length) continue;

      // For each table, compute per-point max in C..K
      const perTable = new Map(); // tableNo -> Map(token -> { token, label, max_C, cell })
      const tableMeta = new Map(); // tableNo -> { supply, humidity, power, supplyUnit, anomalies[] }
      const tableColInfo = new Map(); // tableNo -> { usedCols, usedLabel }
      for (let ti = 0; ti < selectedTables.length; ti += 1) {
        const tableNo = selectedTables[ti].tableNo;
        const startRow = selectedTables[ti].startRow;
        const endRow = (selectedTables[ti + 1] ? selectedTables[ti + 1].startRow : (startRow + 500));

        const timeRow = sheetRows.find(r => Number(r.rowIndex) > startRow && Number(r.rowIndex) < endRow && /(^|\b)Time\b/i.test(String(r.text || '')));
        if (!timeRow) continue;
        const timeRowIndex = Number(timeRow.rowIndex);

        // Prefer "real" time columns (from the Time row), intersected with the requested column range.
        let usedCols = colIndices.slice();
        try {
          const timeCells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex: timeRowIndex,
          }).select('colIndex valueNumber').lean();
          const timeCols = (timeCells || [])
            .filter(c => Number.isFinite(c.valueNumber))
            .filter(c => Number(c.valueNumber) >= 0 && Number(c.valueNumber) <= 100000)
            .map(c => Number(c.colIndex));
          const intersection = timeCols.filter(c => c >= colFrom && c <= colTo).sort((a, b) => a - b);
          if (intersection.length) usedCols = intersection;
        } catch { }
        const usedLabel = `${String.fromCharCode(64 + Math.min(...usedCols))}–${String.fromCharCode(64 + Math.max(...usedCols))}`;
        tableColInfo.set(tableNo, { usedCols, usedLabel });

        const seriesRows = sheetRows
          .filter(r => Number(r.rowIndex) > timeRowIndex && Number(r.rowIndex) < endRow)
          .filter(r => tokenFromLabel(r.text))
          .filter(r => {
            const unit = extractUnitFromRowText(r.text);
            if (unit && (unit.includes('°C') || unit.includes('[°C]') || /[°º]\s*c/i.test(unit))) return true;
            const lbl = extractRowLabelFromRowText(r.text).toLowerCase();
            return !!lbl && (lbl.includes('temperature') || lbl.includes('hőm') || lbl.includes('driver') || lbl.includes('ambient') || lbl.includes('outside') || lbl.includes('cable gland'));
          })
          .slice(0, 80);
        if (!seriesRows.length) continue;

        // Bulk-fetch all needed cells for the series rows (speed).
        const seriesRowIndices = Array.from(new Set(seriesRows.map(r => Number(r.rowIndex)).filter(n => Number.isFinite(n))));
        const allCells = await DatasetTableCell.find({
          tenantId,
          projectId,
          datasetVersion,
          datasetFileId,
          filename,
          sheet,
          rowIndex: { $in: seriesRowIndices },
          colIndex: { $in: usedCols },
        }).select('rowIndex colIndex cell valueRaw valueNumber').lean();

        const byRow = new Map(); // rowIndex -> cells[]
        for (const c of allCells || []) {
          const ri = Number(c?.rowIndex);
          if (!byRow.has(ri)) byRow.set(ri, []);
          byRow.get(ri).push(c);
        }

        const tokenMap = new Map();
        for (const sr of seriesRows) {
          const token = tokenFromLabel(sr.text);
          if (!token) continue;
          const label = extractRowLabelFromRowText(sr.text) || String(sr.text || '').trim();
          const rowIndex = Number(sr.rowIndex);
          const cells = byRow.get(rowIndex) || [];
          const maxCell = pickMaxCell(cells);
          if (!maxCell) continue;
          tokenMap.set(token, {
            token,
            label,
            max_C: Number(maxCell.valueNumber),
            cell: toEvidenceCell({ ...maxCell, filename, sheet }),
          });
        }
        perTable.set(tableNo, tokenMap);

        // Meta rows (supply/humidity/power), using first time column for a stable "scalar" pick.
        const firstCol = usedCols.length ? Number(usedCols[0]) : colFrom;
        const metaKeys = ['supply voltage', 'humidity', 'power'];
        const meta = {};
        const metaEvidence = {};
        const metaUnits = {};
        const anomalies = [];

        const metaRows = sheetRows
          .filter(r => Number(r.rowIndex) > timeRowIndex && Number(r.rowIndex) < endRow)
          .slice(0, 140)
          .map(r => {
            const lbl = normalizeKey(extractRowLabelFromRowText(r.text) || r.text);
            const hit = metaKeys.find(k => lbl.includes(k));
            return hit ? { key: hit, rowIndex: Number(r.rowIndex), unit: extractUnitFromRowText(r.text) } : null;
          })
          .filter(Boolean);

        const wanted = new Map();
        for (const mr of metaRows) {
          if (!wanted.has(mr.key)) wanted.set(mr.key, mr);
        }

        const wantedList = Array.from(wanted.values());
        if (wantedList.length) {
          const wantedRowIndices = wantedList.map(x => Number(x.rowIndex));
          const metaCells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex: { $in: wantedRowIndices },
            colIndex: firstCol,
          }).select('rowIndex colIndex cell valueRaw valueNumber').lean();

          const byMetaRow = new Map();
          for (const c of metaCells || []) byMetaRow.set(Number(c.rowIndex), c);

          for (const mr of wantedList) {
            const c = byMetaRow.get(Number(mr.rowIndex));
            if (!c || !Number.isFinite(c.valueNumber)) continue;
            meta[mr.key] = Number(c.valueNumber);
            metaUnits[mr.key] = String(mr.unit || '');
            metaEvidence[mr.key] = toEvidenceCell({ ...c, filename, sheet });
          }
        }

        // anomaly fix (humidity/supply swapped) - keep evidence aligned to the value source.
        if (Number.isFinite(meta['humidity']) && Number.isFinite(meta['supply voltage'])) {
          if (meta['humidity'] > 100 && meta['supply voltage'] <= 100) {
            anomalies.push('swap_supply_humidity');
            [meta['humidity'], meta['supply voltage']] = [meta['supply voltage'], meta['humidity']];
            [metaUnits['humidity'], metaUnits['supply voltage']] = [metaUnits['supply voltage'], metaUnits['humidity']];
            [metaEvidence['humidity'], metaEvidence['supply voltage']] = [metaEvidence['supply voltage'], metaEvidence['humidity']];
          }
        }

        tableMeta.set(tableNo, {
          supply: meta['supply voltage'] !== undefined ? { value: meta['supply voltage'], unit: metaUnits['supply voltage'] || '', evidence: metaEvidence['supply voltage'] || null } : null,
          humidity: meta['humidity'] !== undefined ? { value: meta['humidity'], unit: metaUnits['humidity'] || '', evidence: metaEvidence['humidity'] || null } : null,
          power: meta['power'] !== undefined ? { value: meta['power'], unit: metaUnits['power'] || '', evidence: metaEvidence['power'] || null } : null,
          supplyUnitNorm: normalizeSupplyUnit(metaUnits['supply voltage'] || ''),
          anomalies,
        });

        for (const k of ['supply voltage', 'humidity', 'power']) {
          const ev = metaEvidence[k];
          if (ev) out.numericEvidence.push(ev);
        }
      }

      if (!perTable.size) continue;

      const tokens = new Set();
      for (const m of perTable.values()) for (const t of m.keys()) tokens.add(t);
      const tokenList = Array.from(tokens).sort((a, b) => {
        const na = Number(String(a).replace(/[^\d]/g, '')) || 0;
        const nb = Number(String(b).replace(/[^\d]/g, '')) || 0;
        return na - nb;
      });

      const matrix = [];
      const significant = [];
      const significantBySupplyType = { VAC: [], VDC: [], other: [] };

      for (const token of tokenList) {
        const row = { point: token, t1: null, t2: null, t3: null, t4: null, spread_C: null };
        const t1 = perTable.get(1)?.get(token) || null;
        const t2 = perTable.get(2)?.get(token) || null;
        const t3 = perTable.get(3)?.get(token) || null;
        const t4 = perTable.get(4)?.get(token) || null;
        row.t1 = t1 ? round1(t1.max_C) : null;
        row.t2 = t2 ? round1(t2.max_C) : null;
        row.t3 = t3 ? round1(t3.max_C) : null;
        row.t4 = t4 ? round1(t4.max_C) : null;

        const available = [t1, t2, t3, t4].filter(Boolean);
        if (available.length >= 2) {
          const minIt = available.slice().sort((a, b) => Number(a.max_C) - Number(b.max_C))[0];
          const maxIt = available.slice().sort((a, b) => Number(b.max_C) - Number(a.max_C))[0];
          const spread = Number(maxIt.max_C) - Number(minIt.max_C);
          row.spread_C = round1(spread);
          if (Math.abs(spread) >= deltaThreshold) {
            const ev = toEvidenceComputed({
              op: 'spread',
              value: round1(spread),
              unit: '°C',
              sources: [maxIt.cell, minIt.cell],
            });
            significant.push({
              point: token,
              compare: 'max(Table1..4) - min(Table1..4)',
              min: { max_C: round1(minIt.max_C), evidence: minIt.cell },
              max: { max_C: round1(maxIt.max_C), evidence: maxIt.cell },
              spread_C: round1(spread),
              evidence: ev,
            });
            out.numericEvidence.push(ev);
          }
        }

        // Also flag within-supply comparisons (common real-world intent).
        const u1 = tableMeta.get(1)?.supplyUnitNorm || '';
        const u2 = tableMeta.get(2)?.supplyUnitNorm || '';
        const u3 = tableMeta.get(3)?.supplyUnitNorm || '';
        const u4 = tableMeta.get(4)?.supplyUnitNorm || '';
        const vac = [u1 === 'VAC' ? t1 : null, u2 === 'VAC' ? t2 : null].filter(Boolean);
        const vdc = [u3 === 'VDC' ? t3 : null, u4 === 'VDC' ? t4 : null].filter(Boolean);

        if (vac.length === 2) {
          const d = Number(vac[1].max_C) - Number(vac[0].max_C);
          if (Math.abs(d) >= deltaThreshold) {
            const ev = toEvidenceComputed({ op: 'delta', value: round1(d), unit: '°C', sources: [vac[1].cell, vac[0].cell] });
            significantBySupplyType.VAC.push({
              point: token,
              compare: 'Table2 - Table1 (VAC)',
              t1: { max_C: round1(vac[0].max_C), evidence: vac[0].cell },
              t2: { max_C: round1(vac[1].max_C), evidence: vac[1].cell },
              delta_C: round1(d),
              evidence: ev,
            });
            out.numericEvidence.push(ev);
          }
        }
        if (vdc.length === 2) {
          const d = Number(vdc[1].max_C) - Number(vdc[0].max_C);
          if (Math.abs(d) >= deltaThreshold) {
            const ev = toEvidenceComputed({ op: 'delta', value: round1(d), unit: '°C', sources: [vdc[1].cell, vdc[0].cell] });
            significantBySupplyType.VDC.push({
              point: token,
              compare: 'Table4 - Table3 (VDC)',
              t3: { max_C: round1(vdc[0].max_C), evidence: vdc[0].cell },
              t4: { max_C: round1(vdc[1].max_C), evidence: vdc[1].cell },
              delta_C: round1(d),
              evidence: ev,
            });
            out.numericEvidence.push(ev);
          }
        }

        // Collect evidence for the matrix row (only existing cells)
        for (const it of [t1, t2, t3, t4]) {
          if (it?.cell) out.numericEvidence.push(it.cell);
        }
        matrix.push(row);
      }

      // Sort significant by absolute delta desc, keep small
      significant.sort((a, b) => Math.abs(Number(b.spread_C)) - Math.abs(Number(a.spread_C)));
      significantBySupplyType.VAC.sort((a, b) => Math.abs(Number(b.delta_C)) - Math.abs(Number(a.delta_C)));
      significantBySupplyType.VDC.sort((a, b) => Math.abs(Number(b.delta_C)) - Math.abs(Number(a.delta_C)));

      out.by_sheet.push({
        fileName: filename,
        sheet,
        tables: [1, 2, 3, 4].filter(n => perTable.has(n)),
        tableMeta: [1, 2, 3, 4]
          .filter(n => tableMeta.has(n))
          .map(n => ({
            table: n,
            columnsUsed: tableColInfo.get(n)?.usedLabel || colLabel,
            supply: tableMeta.get(n)?.supply || null,
            humidity: tableMeta.get(n)?.humidity || null,
            power: tableMeta.get(n)?.power || null,
            anomalies: tableMeta.get(n)?.anomalies || [],
          })),
        matrix: matrix.slice(0, 60),
        significant_spread: significant.slice(0, 30),
        significant: significant.slice(0, 30),
        significant_within_supply: {
          VAC: significantBySupplyType.VAC.slice(0, 20),
          VDC: significantBySupplyType.VDC.slice(0, 20),
        },
      });
    }
  }

  out.numericEvidence = out.numericEvidence.slice(0, 350);
  return { ok: true, result: out };
}

module.exports = {
  enabled,
  detectIntent,
  detectCompareTablesIntent,
  evaluateXlsxMeasurements,
  analyzeMeasurementTables,
  compareTablesColumns,
  __test: {
    extractRowLabelFromRowText,
    extractUnitFromRowText,
    tokenFromLabel,
  },
};
