const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const DatasetTableCell = require('../models/datasetTableCell');
const logger = require('../config/logger');

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
}

function extractRowLabelFromRowText(rowText) {
  const s = String(rowText || '');
  const tryKeys = ['Parameters', 'Parameter', 'Name', '0', 'col_0'];
  for (const k of tryKeys) {
    const re = new RegExp(`\\b${k}=([^|\\n]+)`, 'i');
    const m = s.match(re);
    if (m && String(m[1] || '').trim()) return String(m[1]).trim();
  }
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
  const max = Math.max(5, Math.min(Number(process.env.MEAS_POINT_MAX || 25), 99));
  if (!Number.isInteger(n) || n <= 0 || n > max) return '';
  return token;
}

function safeSlice(obj, maxChars) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return obj;
    return JSON.parse(s.slice(0, maxChars));
  } catch {
    return obj;
  }
}

async function buildXlsxPreview({ tenantId, projectId, datasetVersion, filenames = [], trace = null }) {
  const maxFiles = Math.max(1, Math.min(Number(process.env.XLSX_PLANNER_PREVIEW_MAX_FILES || 3), 10));
  const maxSheets = Math.max(1, Math.min(Number(process.env.XLSX_PLANNER_PREVIEW_MAX_SHEETS || 12), 40));
  const maxRows = Math.max(200, Math.min(Number(process.env.XLSX_PLANNER_PREVIEW_MAX_ROWS || 8000), 40000));
  const maxLabelsPerSheet = Math.max(5, Math.min(Number(process.env.XLSX_PLANNER_PREVIEW_MAX_LABELS || 16), 60));
  const maxChars = Math.max(4000, Math.min(Number(process.env.XLSX_PLANNER_PREVIEW_MAX_CHARS || 35000), 200000));

  const xlsxFiles = (filenames || [])
    .filter(n => /\.xls(x)?$/i.test(String(n || '')))
    .slice(0, maxFiles);

  const result = {
    projectId: String(projectId),
    datasetVersion: Number(datasetVersion),
    files: [],
  };

  for (const filename of xlsxFiles) {
    const fileDoc = await DatasetFile.findOne({ tenantId, projectId, datasetVersion, filename }).select('_id').lean();
    if (!fileDoc) continue;
    const datasetFileId = fileDoc._id;

    const rows = await DatasetRowChunk.find({ tenantId, projectId, datasetVersion, datasetFileId })
      .select('sheet rowIndex text')
      .limit(maxRows)
      .lean();

    const bySheet = new Map();
    for (const r of rows || []) {
      const sh = String(r?.sheet || '').trim();
      if (!sh) continue;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      bySheet.get(sh).push(r);
    }

    const filePreview = { filename, sheets: [] };
    for (const sheet of Array.from(bySheet.keys()).slice(0, maxSheets)) {
      const sheetRows = (bySheet.get(sheet) || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
      if (!sheetRows.length) continue;

      const tableMarkers = [];
      for (const r of sheetRows) {
        const m = String(r?.text || '').match(/\bTable\s+(\d+)\b/i);
        if (!m) continue;
        const n = Number(m[1]);
        if (!Number.isInteger(n) || n <= 0) continue;
        tableMarkers.push({ tableNo: n, rowIndex: Number(r.rowIndex) });
      }
      tableMarkers.sort((a, b) => a.rowIndex - b.rowIndex);
      const table14 = tableMarkers.filter(t => [1, 2, 3, 4].includes(t.tableNo));

      // Grab a few row labels (T1..T12) from the first table block if present, otherwise from the whole sheet.
      const labelCandidates = [];
      for (const r of sheetRows.slice(0, 1200)) {
        const token = tokenFromLabel(r.text);
        if (!token) continue;
        const unit = extractUnitFromRowText(r.text);
        if (unit && !(unit.includes('°C') || unit.includes('[°C]'))) continue;
        labelCandidates.push({
          token,
          label: extractRowLabelFromRowText(r.text),
          unit,
          rowIndex: Number(r.rowIndex),
        });
      }
      const labels = [];
      const seen = new Set();
      for (const c of labelCandidates) {
        if (seen.has(c.token)) continue;
        seen.add(c.token);
        labels.push(c);
        if (labels.length >= maxLabelsPerSheet) break;
      }

      // Try to extract meta for table 1..4 (supply voltage/humidity/power) from first time column.
      const tableSummaries = [];
      for (let i = 0; i < table14.length; i += 1) {
        const t = table14[i];
        const start = Number(t.rowIndex);
        const end = table14[i + 1] ? Number(table14[i + 1].rowIndex) : start + 520;

        const timeRow = sheetRows.find(r => Number(r.rowIndex) > start && Number(r.rowIndex) < end && /(^|\b)Time\b/i.test(String(r.text || '')));
        const timeRowIndex = timeRow ? Number(timeRow.rowIndex) : null;
        let firstTimeCol = null;
        let timeColMin = null;
        let timeColMax = null;
        if (timeRowIndex !== null) {
          const timeCells = await DatasetTableCell.find({
            tenantId,
            projectId,
            datasetVersion,
            datasetFileId,
            filename,
            sheet,
            rowIndex: timeRowIndex,
          }).select('colIndex valueNumber').limit(80).lean();
          const timeCols = (timeCells || [])
            .filter(c => Number.isFinite(c.valueNumber))
            .filter(c => Number(c.valueNumber) >= 0 && Number(c.valueNumber) <= 100000)
            .map(c => Number(c.colIndex));
          if (timeCols.length) {
            timeColMin = Math.min(...timeCols);
            timeColMax = Math.max(...timeCols);
            firstTimeCol = timeColMin;
          }
        }

        const metaKeys = ['supply voltage', 'humidity', 'power'];
        const meta = {};
        const anomalies = [];
        if (firstTimeCol !== null) {
          const rowsInBlock = sheetRows.filter(r => Number(r.rowIndex) > start && Number(r.rowIndex) < end).slice(0, 160);
          const wanted = new Map();
          for (const r of rowsInBlock) {
            const lbl = normalizeKey(extractRowLabelFromRowText(r.text) || r.text);
            const hit = metaKeys.find(k => lbl.includes(k));
            if (!hit) continue;
            if (!wanted.has(hit)) wanted.set(hit, { rowIndex: Number(r.rowIndex), unit: extractUnitFromRowText(r.text) });
          }
          const wantedList = Array.from(wanted.entries()).map(([key, v]) => ({ key, ...v }));
          const wantedRowIndices = wantedList.map(x => Number(x.rowIndex));
          if (wantedRowIndices.length) {
            const metaCells = await DatasetTableCell.find({
              tenantId,
              projectId,
              datasetVersion,
              datasetFileId,
              filename,
              sheet,
              rowIndex: { $in: wantedRowIndices },
              colIndex: firstTimeCol,
            }).select('rowIndex colIndex cell valueRaw valueNumber').lean();
            const byMetaRow = new Map();
            for (const c of metaCells || []) byMetaRow.set(Number(c.rowIndex), c);
            for (const mr of wantedList) {
              const c = byMetaRow.get(Number(mr.rowIndex));
              if (!c) continue;
              meta[mr.key] = {
                value: Number.isFinite(c.valueNumber) ? c.valueNumber : c.valueRaw,
                unit: mr.unit || '',
                cell: String(c.cell || ''),
                colIndex: Number(c.colIndex),
                rowIndex: Number(c.rowIndex),
              };
            }
          }
          const hum = meta['humidity']?.value;
          const sup = meta['supply voltage']?.value;
          if (Number.isFinite(Number(hum)) && Number.isFinite(Number(sup))) {
            if (Number(hum) > 100 && Number(sup) <= 100) anomalies.push('swap_supply_humidity');
          }
        }

        tableSummaries.push({
          tableNo: t.tableNo,
          startRow: start,
          timeRowIndex,
          timeCols: (timeColMin !== null && timeColMax !== null) ? { from: timeColMin, to: timeColMax } : null,
          meta,
          anomalies,
        });
      }

      filePreview.sheets.push({
        sheet,
        tablesFound: table14.map(t => ({ tableNo: t.tableNo, rowIndex: t.rowIndex })).slice(0, 12),
        pointLabels: labels,
        tablePreview: tableSummaries.slice(0, 6),
      });
    }

    // Trim to keep planner prompts stable.
    result.files.push(safeSlice(filePreview, maxChars));
  }

  try {
    logger.info('xlsx.preview.done', {
      requestId: trace?.requestId,
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      files: result.files.length,
    });
  } catch { }

  return result;
}

module.exports = {
  buildXlsxPreview,
};

