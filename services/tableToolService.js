const crypto = require('crypto');
const logger = require('../config/logger');

const DatasetTableCell = require('../models/datasetTableCell');
const DatasetDerivedMetric = require('../models/datasetDerivedMetric');

function colLetterToIndex1(col) {
  const s = String(col || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n;
}

function stableId(parts) {
  const raw = parts.map(p => String(p ?? '')).join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
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

function pickCellByCol(cells, colIndex) {
  const want = Number(colIndex);
  if (!Number.isInteger(want)) return null;
  return (cells || []).find(c => Number(c?.colIndex) === want) || null;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  // Keep stable numeric formatting (dot) for parsing/validation
  const v = Math.round(n * 1e6) / 1e6;
  return String(v);
}

async function computeAndStoreDefaultDerivedMetrics({
  tenantId,
  projectId,
  datasetId,
  datasetVersion,
  datasetFileId,
  filename,
  schema,
  trace = null,
}) {
  const debugEnabled =
    String(process.env.DEBUG_GOVERNED || '').trim() === '1' ||
    String(process.env.DEBUG_GOVERNED || '').trim().toLowerCase() === 'true';

  const sheets = Array.isArray(schema?.sheets) ? schema.sheets : [];
  if (!sheets.length) return { ok: true, derived: 0, skipped: true };

  let created = 0;

  for (const sh of sheets) {
    const sheet = String(sh?.sheet || '').trim();
    if (!sheet) continue;
    const tables = Array.isArray(sh?.tables) ? sh.tables : [];

    for (const t of tables) {
      if (String(t?.type || '') !== 'time_series') continue;
      const series = Array.isArray(t?.series) ? t.series : [];
      if (!series.length) continue;

      const colStart = colLetterToIndex1(t?.time?.colStart);
      const colEnd = colLetterToIndex1(t?.time?.colEnd);
      if (!colStart || !colEnd) continue;
      const minCol = Math.min(colStart, colEnd);
      const maxCol = Math.max(colStart, colEnd);

      // Fetch all numeric cells for the series rows in one query (bounded).
      const rows = series
        .map(s => Number(s?.row))
        .filter(n => Number.isInteger(n) && n > 0)
        .slice(0, 512);
      if (!rows.length) continue;

      const cells = await DatasetTableCell.find({
        tenantId,
        projectId,
        datasetVersion: Number(datasetVersion),
        datasetFileId,
        filename,
        sheet,
        rowIndex: { $in: rows },
        colIndex: { $gte: minCol, $lte: maxCol },
      })
        .select('sheet rowIndex colIndex cell valueRaw valueNumber colHeader')
        .lean();

      // Group by rowIndex for fast lookup
      const byRow = new Map();
      for (const c of cells || []) {
        const r = Number(c?.rowIndex);
        if (!byRow.has(r)) byRow.set(r, []);
        byRow.get(r).push(c);
      }

      for (const s of series) {
        const row = Number(s?.row);
        if (!Number.isInteger(row) || row <= 0) continue;
        const rowCells = byRow.get(row) || [];
        const unit = String(s?.unit || '').trim();
        const seriesName = String(s?.name || '').trim();
        const tableName = String(t?.name || '').trim();

        const maxCell = pickMaxCell(rowCells);
        const minCell = pickMinCell(rowCells);
        const sortedByCol = rowCells
          .filter(c => Number.isFinite(Number(c?.valueNumber)))
          .slice()
          .sort((a, b) => Number(a.colIndex) - Number(b.colIndex));
        const firstCell = sortedByCol.length ? sortedByCol[0] : null;
        const lastCell = sortedByCol.length ? sortedByCol[sortedByCol.length - 1] : null;

        const upsertMetric = async ({ suffix, metricKey, label, op, valueNumber, valueText, sources }) => {
          if (!sources || !sources.length) return;
          const derivedId = `dm_${stableId([tenantId, projectId, datasetVersion, datasetFileId, sheet, tableName, seriesName, suffix])}`;
          const doc = {
            tenantId,
            projectId,
            datasetId,
            datasetVersion: Number(datasetVersion),
            datasetFileId,
            filename,
            sheet,
            derivedId,
            metricKey,
            label,
            unit,
            valueNumber: Number.isFinite(Number(valueNumber)) ? Number(valueNumber) : null,
            valueText: String(valueText || '').trim(),
            op,
            sources,
            meta: { tableName, seriesName },
          };
          await DatasetDerivedMetric.updateOne(
            { tenantId, projectId, datasetVersion: Number(datasetVersion), derivedId },
            { $set: doc },
            { upsert: true }
          );
          created += 1;
        };

        if (maxCell) {
          await upsertMetric({
            suffix: 'max_cell',
            metricKey: 'timeseries.max_cell',
            label: `MAX(${seriesName})`,
            op: 'max_cell',
            valueNumber: maxCell.valueNumber,
            valueText: String(maxCell.valueRaw || '').trim() || formatNumber(Number(maxCell.valueNumber)),
            sources: [{ fileName: filename, sheet, cell: String(maxCell.cell || '').trim(), rowIndex: Number(maxCell.rowIndex), colIndex: Number(maxCell.colIndex), value: String(maxCell.valueRaw || '').trim() }],
          });
        }
        if (minCell) {
          await upsertMetric({
            suffix: 'min_cell',
            metricKey: 'timeseries.min_cell',
            label: `MIN(${seriesName})`,
            op: 'min_cell',
            valueNumber: minCell.valueNumber,
            valueText: String(minCell.valueRaw || '').trim() || formatNumber(Number(minCell.valueNumber)),
            sources: [{ fileName: filename, sheet, cell: String(minCell.cell || '').trim(), rowIndex: Number(minCell.rowIndex), colIndex: Number(minCell.colIndex), value: String(minCell.valueRaw || '').trim() }],
          });
        }
        if (firstCell) {
          await upsertMetric({
            suffix: 'first_cell',
            metricKey: 'timeseries.first_cell',
            label: `FIRST(${seriesName})`,
            op: 'first_cell',
            valueNumber: firstCell.valueNumber,
            valueText: String(firstCell.valueRaw || '').trim() || formatNumber(Number(firstCell.valueNumber)),
            sources: [{ fileName: filename, sheet, cell: String(firstCell.cell || '').trim(), rowIndex: Number(firstCell.rowIndex), colIndex: Number(firstCell.colIndex), value: String(firstCell.valueRaw || '').trim() }],
          });
        }
        if (lastCell) {
          await upsertMetric({
            suffix: 'last_cell',
            metricKey: 'timeseries.last_cell',
            label: `LAST(${seriesName})`,
            op: 'last_cell',
            valueNumber: lastCell.valueNumber,
            valueText: String(lastCell.valueRaw || '').trim() || formatNumber(Number(lastCell.valueNumber)),
            sources: [{ fileName: filename, sheet, cell: String(lastCell.cell || '').trim(), rowIndex: Number(lastCell.rowIndex), colIndex: Number(lastCell.colIndex), value: String(lastCell.valueRaw || '').trim() }],
          });
        }

        // Computed delta: max - first (traceable to 2 cells). Value isn't a single cell; stored for tooling.
        if (maxCell && firstCell && Number.isFinite(Number(maxCell.valueNumber)) && Number.isFinite(Number(firstCell.valueNumber))) {
          const delta = Number(maxCell.valueNumber) - Number(firstCell.valueNumber);
          await upsertMetric({
            suffix: 'delta_max_first',
            metricKey: 'timeseries.delta_max_first',
            label: `DELTA_MAX_FIRST(${seriesName})`,
            op: 'delta',
            valueNumber: delta,
            valueText: formatNumber(delta),
            sources: [
              { fileName: filename, sheet, cell: String(maxCell.cell || '').trim(), rowIndex: Number(maxCell.rowIndex), colIndex: Number(maxCell.colIndex), value: String(maxCell.valueRaw || '').trim() },
              { fileName: filename, sheet, cell: String(firstCell.cell || '').trim(), rowIndex: Number(firstCell.rowIndex), colIndex: Number(firstCell.colIndex), value: String(firstCell.valueRaw || '').trim() },
            ],
          });
        }

        // Steady-state heuristic: last 3 points range (max-min) <= threshold. Store the range.
        const steadyN = Math.max(3, Math.min(Number(process.env.TABLE_STEADY_N || 3), 6));
        if (sortedByCol.length >= steadyN) {
          const tail = sortedByCol.slice(-steadyN);
          const tailMax = pickMaxCell(tail);
          const tailMin = pickMinCell(tail);
          if (tailMax && tailMin && Number.isFinite(Number(tailMax.valueNumber)) && Number.isFinite(Number(tailMin.valueNumber))) {
            const range = Number(tailMax.valueNumber) - Number(tailMin.valueNumber);
            await upsertMetric({
              suffix: `steady_range_last${steadyN}`,
              metricKey: 'timeseries.steady_range',
              label: `STEADY_RANGE_LAST_${steadyN}(${seriesName})`,
              op: 'range',
              valueNumber: range,
              valueText: formatNumber(range),
              sources: [
                { fileName: filename, sheet, cell: String(tailMax.cell || '').trim(), rowIndex: Number(tailMax.rowIndex), colIndex: Number(tailMax.colIndex), value: String(tailMax.valueRaw || '').trim() },
                { fileName: filename, sheet, cell: String(tailMin.cell || '').trim(), rowIndex: Number(tailMin.rowIndex), colIndex: Number(tailMin.colIndex), value: String(tailMin.valueRaw || '').trim() },
              ],
              meta: { tableName, seriesName, steadyN },
            });
          }
        }
      }
    }
  }

  if (debugEnabled) {
    try {
      logger.info('table.metrics.derived', { requestId: trace?.requestId, filename, derived: created });
    } catch { }
  }
  return { ok: true, derived: created };
}

async function listDerivedMetrics({
  tenantId,
  projectId,
  datasetVersion,
  datasetFileIds = [],
  limit = 200,
}) {
  const q = { tenantId, projectId, datasetVersion: Number(datasetVersion) };
  if (Array.isArray(datasetFileIds) && datasetFileIds.length) {
    q.datasetFileId = { $in: datasetFileIds };
  }
  return DatasetDerivedMetric.find(q)
    .sort({ filename: 1, sheet: 1, derivedId: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 200, 500)))
    .lean();
}

module.exports = {
  computeAndStoreDefaultDerivedMetrics,
  listDerivedMetrics,
  colLetterToIndex1,
};
