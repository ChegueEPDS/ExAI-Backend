const { loadRows, resolveColumnNameFromList, parseNumberLoose, applyFilter } = require('./tableRowUtil');

function bucketKey(date, freq) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  if (freq === 'H') return new Date(Date.UTC(y, m, day, h, 0, 0, 0)).toISOString();
  if (freq === 'D') return new Date(Date.UTC(y, m, day, 0, 0, 0, 0)).toISOString();
  if (freq === 'W') {
    const dow = d.getUTCDay(); // 0..6
    const start = new Date(Date.UTC(y, m, day - dow, 0, 0, 0, 0));
    return start.toISOString();
  }
  if (freq === 'M') return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0)).toISOString();
}

function aggValues(values, agg) {
  const nums = values.map(parseNumberLoose).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'min') return Math.min(...nums);
  if (agg === 'max') return Math.max(...nums);
  if (agg === 'median') {
    const sorted = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  if (agg === 'count') return values.length;
  return nums.reduce((a, b) => a + b, 0) / nums.length; // mean default
}

function addTrend(rows, cols, window) {
  if (!window || window < 2) return rows;
  const out = rows.map(r => ({ ...r }));
  for (const c of cols) {
    const vals = out.map(r => parseNumberLoose(r[c]));
    for (let i = 0; i < out.length; i += 1) {
      const start = Math.max(0, i - window + 1);
      const slice = vals.slice(start, i + 1).filter(v => typeof v === 'number' && Number.isFinite(v));
      out[i][`${c}_trend`] = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
    }
  }
  return out;
}

async function runTimeSeriesJS({
  tenantId,
  projectId,
  datasetVersion,
  filename,
  sheet = null,
  timeColumn,
  valueColumns = [],
  freq = null,
  agg = 'mean',
  trendWindow = null,
  filters = null,
  limit = 500,
  maxRows = 12000,
  maxCols = 80,
}) {
  const r = await loadRows({ tenantId, projectId, datasetVersion, filename, sheet, maxRows });
  if (!r?.ok) return { ok: false, error: 'file_not_found' };
  const rows = r.rows || [];
  const columns = (r.columns || []).filter(c => !String(c).startsWith('__')).slice(0, maxCols);

  const timeCol = resolveColumnNameFromList(columns, timeColumn);
  const valueCols = valueColumns.map(c => resolveColumnNameFromList(columns, c)).filter(Boolean);
  if (!timeCol || !valueCols.length) return { ok: false, error: 'columns_not_found' };

  const filtered = (filters && Array.isArray(filters) && filters.length)
    ? rows.filter(r0 => filters.every(f => applyFilter(r0, f)))
    : rows;

  const normAgg = String(agg || 'mean').toLowerCase();
  const freqNorm = freq ? String(freq).toUpperCase() : null;

  let outRows = [];
  if (freqNorm) {
    const buckets = new Map();
    for (const row of filtered) {
      const t = row?.[timeCol];
      const key = bucketKey(t, freqNorm);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    const keys = Array.from(buckets.keys()).sort();
    for (const k of keys) {
      const bucketRows = buckets.get(k);
      const out = { [timeCol]: k };
      for (const c of valueCols) {
        const vals = bucketRows.map(r0 => r0?.[c]);
        out[c] = aggValues(vals, normAgg);
      }
      outRows.push(out);
    }
  } else {
    const out = { [timeCol]: null };
    for (const c of valueCols) {
      const vals = filtered.map(r0 => r0?.[c]);
      out[c] = aggValues(vals, normAgg);
    }
    outRows = [out];
  }

  outRows = addTrend(outRows, valueCols, Number(trendWindow || 0));
  const useLimit = Math.max(1, Math.min(Number(limit || 500), 2000));
  outRows = outRows.slice(0, useLimit);

  return {
    ok: true,
    result: {
      rows: outRows,
      meta: {
        filename: r.filename || filename,
        sheet: sheet || null,
        time_column: timeCol,
        value_columns: valueCols,
        freq: freqNorm,
        agg: normAgg,
        trend_window: trendWindow ? Number(trendWindow) : null,
        rows_scanned: filtered.length,
        rows_out: outRows.length,
        columns: Object.keys(outRows[0] || {}),
      },
    },
  };
}

module.exports = {
  runTimeSeriesJS,
};
