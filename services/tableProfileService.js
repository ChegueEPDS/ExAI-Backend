const { parseNumberLoose, loadRows } = require('./tableRowUtil');

function numericStats(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const q1 = sorted[Math.floor((n - 1) * 0.25)];
  const q3 = sorted[Math.floor((n - 1) * 0.75)];
  return { min: sorted[0], max: sorted[n - 1], mean, std, q1, q3 };
}

async function runTableProfileJS({ tenantId, projectId, datasetVersion, filename, sheet = null, maxRows = 12000, maxCols = 80 }) {
  const r = await loadRows({ tenantId, projectId, datasetVersion, filename, sheet, maxRows });
  if (!r?.ok) return { ok: false, error: 'file_not_found' };
  const rows = r.rows || [];
  const columns = (r.columns || []).filter(c => !String(c).startsWith('__')).slice(0, Math.max(1, Number(maxCols || 80)));
  const totalRows = rows.length;

  const profiles = [];
  for (const c of columns) {
    const vals = rows.map(x => x?.[c]).filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    const missing = totalRows - vals.length;
    const missingPct = totalRows ? (missing / totalRows) * 100 : 0;
    const numericVals = vals.map(parseNumberLoose).filter(v => typeof v === 'number' && Number.isFinite(v));
    const isNumeric = numericVals.length > 0;
    const stats = isNumeric ? numericStats(numericVals) : null;

    let outliers = 0;
    if (stats && numericVals.length >= 8) {
      const iqr = stats.q3 - stats.q1;
      if (iqr !== 0) {
        const lo = stats.q1 - 1.5 * iqr;
        const hi = stats.q3 + 1.5 * iqr;
        outliers = numericVals.filter(v => v < lo || v > hi).length;
      }
    }

    profiles.push({
      column: String(c),
      dtype: isNumeric ? 'number' : 'string',
      rows: totalRows,
      missing,
      missing_pct: Number(missingPct.toFixed(2)),
      unique: new Set(vals.map(v => String(v))).size,
      is_numeric: isNumeric,
      min: stats ? stats.min : null,
      max: stats ? stats.max : null,
      mean: stats ? stats.mean : null,
      std: stats ? stats.std : null,
      outliers,
    });
  }

  return {
    ok: true,
    result: {
      meta: {
        filename: r.filename || filename,
        sheet: sheet || null,
        rows_scanned: totalRows,
        columns,
      },
      profiles,
    },
  };
}

module.exports = {
  runTableProfileJS,
};
