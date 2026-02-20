const { loadRows, resolveColumnNameFromList, applyFilter, parseNumberLoose } = require('./tableRowUtil');

function aggValues(values, agg) {
  const nums = values.map(parseNumberLoose).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) {
    if (agg === 'count') return values.length;
    return null;
  }
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'min') return Math.min(...nums);
  if (agg === 'max') return Math.max(...nums);
  if (agg === 'median') {
    const sorted = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  if (agg === 'count') return values.length;
  // mean default
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function runTablePivotJS({
  tenantId,
  projectId,
  datasetVersion,
  filename,
  sheet = null,
  groupBy = [],
  values = [],
  agg = null,
  filters = null,
  sort = null,
  limit = 200,
  maxRows = 12000,
  maxCols = 80,
}) {
  const r = await loadRows({ tenantId, projectId, datasetVersion, filename, sheet, maxRows });
  if (!r?.ok) return { ok: false, error: 'file_not_found' };
  const rows = r.rows || [];
  const columns = (r.columns || []).filter(c => !String(c).startsWith('__')).slice(0, maxCols);

  const groupCols = groupBy.map(c => resolveColumnNameFromList(columns, c)).filter(Boolean);
  const valueCols = values.map(c => resolveColumnNameFromList(columns, c)).filter(Boolean);
  if (!groupCols.length || !valueCols.length) return { ok: false, error: 'columns_not_found' };

  const aggList = Array.isArray(agg) ? agg : (agg ? [agg] : ['sum']);
  const normAgg = aggList.map(a => String(a || '').toLowerCase()).filter(Boolean);

  const filtered = (filters && Array.isArray(filters) && filters.length)
    ? rows.filter(r0 => filters.every(f => applyFilter(r0, f)))
    : rows;

  const groups = new Map();
  for (const row of filtered) {
    const key = groupCols.map(c => String(row?.[c] ?? '')).join('|');
    if (!groups.has(key)) {
      groups.set(key, { key, rows: [], groupVals: Object.fromEntries(groupCols.map(c => [c, row?.[c] ?? ''])) });
    }
    groups.get(key).rows.push(row);
  }

  const outRows = [];
  for (const g of groups.values()) {
    const out = { ...g.groupVals };
    for (let i = 0; i < valueCols.length; i += 1) {
      const col = valueCols[i];
      const aggOp = normAgg[i] || normAgg[0] || 'sum';
      const vals = g.rows.map(r0 => r0?.[col]);
      out[`${col}_${aggOp}`] = aggValues(vals, aggOp);
    }
    outRows.push(out);
  }

  let resultRows = outRows;
  if (Array.isArray(sort)) {
    for (const s of sort) {
      const col = String(s?.column || '').trim();
      if (!col) continue;
      const dir = String(s?.dir || 'asc').toLowerCase();
      resultRows = resultRows.slice().sort((a, b) => {
        const va = a?.[col];
        const vb = b?.[col];
        if (va == null && vb == null) return 0;
        if (va == null) return dir === 'desc' ? 1 : -1;
        if (vb == null) return dir === 'desc' ? -1 : 1;
        if (va < vb) return dir === 'desc' ? 1 : -1;
        if (va > vb) return dir === 'desc' ? -1 : 1;
        return 0;
      });
    }
  }

  const useLimit = Math.max(1, Math.min(Number(limit || 200), 1000));
  resultRows = resultRows.slice(0, useLimit);

  return {
    ok: true,
    result: {
      rows: resultRows,
      meta: {
        filename: r.filename || filename,
        sheet: sheet || null,
        rows_scanned: rows.length,
        rows_out: resultRows.length,
        group_by: groupCols,
        values: valueCols,
        aggregations: normAgg,
        columns: Object.keys(resultRows[0] || {}),
      },
    },
  };
}

module.exports = {
  runTablePivotJS,
};
