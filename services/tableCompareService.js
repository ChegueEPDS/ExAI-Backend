const { loadRows, resolveColumnNameFromList, simplifyKey, parseNumberLoose } = require('./tableRowUtil');

function isNumberLike(v) {
  const n = parseNumberLoose(v);
  return typeof n === 'number' && Number.isFinite(n);
}

function extractMatrixRecords(rows, columns) {
  const records = [];
  let labels = [];
  let currentHeaders = null;

  const isLabelRow = (row) => {
    const nonNull = Object.values(row || {}).filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
    const v0 = row?.[columns[0]];
    return nonNull <= 2 && typeof v0 === 'string' && v0.trim();
  };

  const isHeaderRow = (row) => {
    const v0 = row?.[columns[0]];
    if (typeof v0 !== 'string' || !v0.trim()) return false;
    let numeric = 0;
    for (const c of columns.slice(2)) {
      if (isNumberLike(row?.[c])) numeric += 1;
    }
    return numeric >= 3;
  };

  for (const row of rows) {
    if (isLabelRow(row)) {
      labels.push(String(row[columns[0]]).trim());
      if (labels.length > 4) labels = labels.slice(-4);
    }
    if (isHeaderRow(row)) {
      const headers = [];
      for (const c of columns.slice(2)) {
        const hv = row?.[c];
        if (isNumberLike(hv)) headers.push({ col: c, header: hv });
      }
      currentHeaders = { headers, block: labels.slice(-2).join(' | ') || null };
      continue;
    }
    if (currentHeaders) {
      const rowLabel = row?.[columns[0]];
      if (typeof rowLabel === 'string' && rowLabel.trim()) {
        for (const h of currentHeaders.headers) {
          const val = row?.[h.col];
          if (val === null || val === undefined || String(val).trim() === '') continue;
          records.push({
            block: currentHeaders.block,
            row_label: rowLabel,
            col_header: h.header,
            value: val,
          });
        }
      }
    }
  }
  return records;
}

function buildKey(row, keyCols) {
  return keyCols.map(c => String(row?.[c] ?? '')).join('|');
}

async function runTableCompareJS({
  tenantId,
  projectId,
  datasetVersion,
  left,
  right,
  keyColumns,
  compareColumns = null,
  maxRows = 12000,
  maxCols = 80,
}) {
  const leftRes = await loadRows({ tenantId, projectId, datasetVersion, filename: left.filename, sheet: left.sheet || null, maxRows });
  const rightRes = await loadRows({ tenantId, projectId, datasetVersion, filename: right.filename, sheet: right.sheet || null, maxRows });
  if (!leftRes?.ok || !rightRes?.ok) return { ok: false, error: 'file_not_found' };

  const leftCols = (leftRes.columns || []).filter(c => !String(c).startsWith('__')).slice(0, maxCols);
  const rightCols = (rightRes.columns || []).filter(c => !String(c).startsWith('__')).slice(0, maxCols);

  const resolveList = (cols, wants) => (wants || []).map(w => resolveColumnNameFromList(cols, w)).filter(Boolean);
  const leftKey = resolveList(leftCols, keyColumns);
  const rightKey = resolveList(rightCols, keyColumns);
  if (!leftKey.length || !rightKey.length) return { ok: false, error: 'key_columns_not_found' };

  let compCols = [];
  if (compareColumns && compareColumns.length) {
    const leftComp = resolveList(leftCols, compareColumns);
    const rightComp = resolveList(rightCols, compareColumns);
    const rightSet = new Set(rightComp.map(c => simplifyKey(c)));
    compCols = leftComp.filter(c => rightSet.has(simplifyKey(c)));
  } else {
    const rightSet = new Set(rightCols.map(c => simplifyKey(c)));
    compCols = leftCols.filter(c => rightSet.has(simplifyKey(c)) && !leftKey.includes(c));
  }

  const leftMap = new Map();
  for (const row of leftRes.rows || []) {
    const k = buildKey(row, leftKey);
    if (!leftMap.has(k)) leftMap.set(k, []);
    leftMap.get(k).push(row);
  }
  const rightMap = new Map();
  for (const row of rightRes.rows || []) {
    const k = buildKey(row, rightKey);
    if (!rightMap.has(k)) rightMap.set(k, []);
    rightMap.get(k).push(row);
  }

  const leftKeys = new Set(leftMap.keys());
  const rightKeys = new Set(rightMap.keys());
  const addedKeys = Array.from(rightKeys).filter(k => !leftKeys.has(k));
  const removedKeys = Array.from(leftKeys).filter(k => !rightKeys.has(k));
  const commonKeys = Array.from(leftKeys).filter(k => rightKeys.has(k));

  const changes = [];
  const duplicateKeys = [];
  for (const k of commonKeys.slice(0, 200)) {
    const lArr = leftMap.get(k) || [];
    const rArr = rightMap.get(k) || [];
    if (lArr.length > 1 || rArr.length > 1) {
      duplicateKeys.push({ key: k, left_count: lArr.length, right_count: rArr.length });
    }
    let pairs = 0;
    for (let li = 0; li < lArr.length; li += 1) {
      for (let ri = 0; ri < rArr.length; ri += 1) {
        const l = lArr[li];
        const r = rArr[ri];
        const diffs = {};
        for (const c of compCols) {
          const lv = l?.[c];
          const rv = r?.[c];
          if (String(lv ?? '') !== String(rv ?? '')) {
            diffs[c] = { left: lv ?? null, right: rv ?? null };
          }
        }
        if (Object.keys(diffs).length) changes.push({ key: k, left_index: li + 1, right_index: ri + 1, diffs });
        pairs += 1;
        if (pairs >= 20) break;
      }
      if (pairs >= 20) break;
    }
  }

  // Matrix fallback if keys are duplicated or parameter-like
  if (duplicateKeys.length || (keyColumns.length === 1 && String(keyColumns[0]).toLowerCase().startsWith('param'))) {
    const leftRecords = extractMatrixRecords(leftRes.rows || [], leftCols);
    const rightRecords = extractMatrixRecords(rightRes.rows || [], rightCols);
    const leftMap2 = new Map();
    for (const r of leftRecords) {
      const k2 = `${r.block}|${r.row_label}|${r.col_header}`;
      if (!leftMap2.has(k2)) leftMap2.set(k2, r.value);
    }
    const rightMap2 = new Map();
    for (const r of rightRecords) {
      const k2 = `${r.block}|${r.row_label}|${r.col_header}`;
      if (!rightMap2.has(k2)) rightMap2.set(k2, r.value);
    }
    const leftKeys2 = new Set(leftMap2.keys());
    const rightKeys2 = new Set(rightMap2.keys());
    const added2 = Array.from(rightKeys2).filter(k2 => !leftKeys2.has(k2));
    const removed2 = Array.from(leftKeys2).filter(k2 => !rightKeys2.has(k2));
    const common2 = Array.from(leftKeys2).filter(k2 => rightKeys2.has(k2));
    const changes2 = [];
    for (const k2 of common2.slice(0, 500)) {
      const lv = leftMap2.get(k2);
      const rv = rightMap2.get(k2);
      if (String(lv ?? '') !== String(rv ?? '')) {
        changes2.push({ key: k2, diffs: { value: { left: lv ?? null, right: rv ?? null } } });
      }
    }
    return {
      ok: true,
      result: {
        meta: {
          left: { filename: leftRes.filename, sheet: left.sheet || null },
          right: { filename: rightRes.filename, sheet: right.sheet || null },
          key_columns: ['block', 'row_label', 'col_header'],
          compare_columns: ['value'],
          rows_left: leftRes.rows.length,
          rows_right: rightRes.rows.length,
          added: added2.length,
          removed: removed2.length,
          changed: changes2.length,
          mode: 'matrix',
          duplicate_keys: duplicateKeys.slice(0, 50),
        },
        added_keys: added2.slice(0, 50),
        removed_keys: removed2.slice(0, 50),
        changes: changes2.slice(0, 50),
      },
    };
  }

  return {
    ok: true,
    result: {
      meta: {
        left: { filename: leftRes.filename, sheet: left.sheet || null },
        right: { filename: rightRes.filename, sheet: right.sheet || null },
        key_columns: keyColumns,
        compare_columns: compareColumns || compCols,
        rows_left: leftRes.rows.length,
        rows_right: rightRes.rows.length,
        added: addedKeys.length,
        removed: removedKeys.length,
        changed: changes.length,
        duplicate_keys: duplicateKeys.slice(0, 50),
      },
      added_keys: addedKeys.slice(0, 50),
      removed_keys: removedKeys.slice(0, 50),
      changes: changes.slice(0, 50),
    },
  };
}

module.exports = {
  runTableCompareJS,
};
