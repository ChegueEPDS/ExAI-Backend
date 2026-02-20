const axios = require('axios');

function isEnabled() {
  return String(process.env.PY_CALC_ENABLED || '').toLowerCase() === 'true';
}

function getBaseUrl() {
  return String(process.env.PY_CALC_URL || 'http://127.0.0.1:9000').trim();
}

async function runTableQueryPython({ files, query, maxRows = null, timeoutMs = 120000 }) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/table_query`;
  const payload = { files, query, max_rows: maxRows || null };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

async function runTableProfilePython({ files, sheet = null, maxRows = null, maxCols = null, timeoutMs = 120000 }) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/table_profile`;
  const payload = { files, sheet, max_rows: maxRows || null, max_cols: maxCols || null };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

async function runTableComparePython({
  files,
  left,
  right,
  keyColumns,
  compareColumns = null,
  maxRows = null,
  maxCols = null,
  timeoutMs = 120000
}) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/table_compare`;
  const payload = {
    files,
    left,
    right,
    key_columns: keyColumns,
    compare_columns: compareColumns || null,
    max_rows: maxRows || null,
    max_cols: maxCols || null,
  };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

async function runTablePivotPython({
  files,
  filename = null,
  sheet = null,
  groupBy = [],
  values = [],
  agg = null,
  filters = null,
  sort = null,
  limit = null,
  maxRows = null,
  maxCols = null,
  timeoutMs = 120000,
}) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/table_pivot`;
  const payload = {
    files,
    filename,
    sheet,
    group_by: groupBy,
    values,
    agg: agg || null,
    filters: filters || null,
    sort: sort || null,
    limit: limit || null,
    max_rows: maxRows || null,
    max_cols: maxCols || null,
  };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

async function runTimeSeriesPython({
  files,
  filename = null,
  sheet = null,
  timeColumn,
  valueColumns = [],
  freq = null,
  agg = null,
  trendWindow = null,
  filters = null,
  limit = null,
  maxRows = null,
  maxCols = null,
  timeoutMs = 120000,
}) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/time_series`;
  const payload = {
    files,
    filename,
    sheet,
    time_column: timeColumn,
    value_columns: valueColumns,
    freq,
    agg,
    trend_window: trendWindow,
    filters: filters || null,
    limit: limit || null,
    max_rows: maxRows || null,
    max_cols: maxCols || null,
  };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

async function runMeasurementEvalPython({
  files,
  filename = null,
  sheet = null,
  maxTables = null,
  maxRows = null,
  maxCols = null,
  extPoints = null,
  timeoutMs = 120000,
}) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'PY_CALC_ENABLED is off' };
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/calc/measurement_eval`;
  const payload = {
    files,
    filename,
    sheet,
    max_tables: maxTables || null,
    max_rows: maxRows || null,
    max_cols: maxCols || null,
    ext_points: extPoints || null,
  };

  const resp = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  return resp.data;
}

module.exports = {
  isEnabled,
  runTableQueryPython,
  runTableProfilePython,
  runTableComparePython,
  runTablePivotPython,
  runTimeSeriesPython,
  runMeasurementEvalPython,
};
