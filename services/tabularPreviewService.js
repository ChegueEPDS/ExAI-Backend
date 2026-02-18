const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');

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

function safeSlice(obj, maxChars) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return obj;
    return JSON.parse(s.slice(0, maxChars));
  } catch {
    return obj;
  }
}

async function buildTabularPreview({ tenantId, projectId, datasetVersion, filenames = [], trace = null }) {
  const maxFiles = Math.max(1, Math.min(Number(systemSettings.getNumber('TABLE_QUERY_MAX_FILES') || 3), 10));
  const maxRows = Math.max(50, Math.min(Number(systemSettings.getNumber('TABLE_QUERY_PREVIEW_MAX_ROWS') || 400), 5000));
  const maxCols = Math.max(8, Math.min(Number(systemSettings.getNumber('TABLE_QUERY_PREVIEW_MAX_COLS') || 25), 80));
  const maxChars = Math.max(8000, Math.min(Number(systemSettings.getNumber('XLSX_PLANNER_PREVIEW_MAX_CHARS') || 35000), 200000));

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
      .limit(Math.max(200, maxRows * 6))
      .lean();

    const bySheet = new Map();
    for (const r of rows || []) {
      const sh = String(r?.sheet || '').trim();
      if (!sh) continue;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      bySheet.get(sh).push(r);
    }

    const filePreview = { filename, sheets: [] };
    for (const sheet of Array.from(bySheet.keys()).slice(0, 24)) {
      const sheetRows = (bySheet.get(sheet) || []).slice().sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
      const scan = sheetRows.slice(0, maxRows);
      if (!scan.length) continue;

      const colFreq = new Map();
      const parsedRows = [];
      for (const rr of scan) {
        const obj = parseRowChunkText(rr.text);
        parsedRows.push({ rowIndex: Number(rr.rowIndex), obj });
        for (const k of Object.keys(obj)) {
          colFreq.set(k, (colFreq.get(k) || 0) + 1);
        }
      }

      const columns = Array.from(colFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)
        .slice(0, maxCols);

      const sampleRows = parsedRows.slice(0, 3).map(r => ({
        rowIndex: r.rowIndex,
        values: Object.fromEntries(columns.map(c => [c, String(r.obj?.[c] ?? '')]).filter(([, v]) => v)),
      }));

      filePreview.sheets.push({
        sheet,
        columns,
        sampleRows,
        scannedRows: scan.length,
      });
    }

    result.files.push(safeSlice(filePreview, maxChars));
  }

  try {
    logger.info('table.preview.done', {
      requestId: trace?.requestId,
      projectId: String(projectId),
      datasetVersion: Number(datasetVersion),
      files: result.files.length,
    });
  } catch { }

  return result;
}

module.exports = {
  buildTabularPreview,
  __test: { parseRowChunkText },
};

