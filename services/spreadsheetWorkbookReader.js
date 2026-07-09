const ExcelJS = require('exceljs');

function columnName(colNumber) {
  let n = Number(colNumber) || 0;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name || 'A';
}

function cellAddress(rowNumber, colNumber) {
  return `${columnName(colNumber)}${rowNumber}`;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part?.text || '').join('');
    }
    if (value.text !== undefined) return normalizeCellValue(value.text);
    if (value.result !== undefined) return normalizeCellValue(value.result);
    if (value.hyperlink && value.text) return normalizeCellValue(value.text);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function worksheetToRows(worksheet, { includeEmpty = true, maxRows = Infinity, maxCols = Infinity } = {}) {
  const rowCount = Math.min(worksheet.rowCount || 0, maxRows);
  const columnCount = Math.min(worksheet.columnCount || 0, maxCols);
  const rows = [];

  for (let r = 1; r <= rowCount; r += 1) {
    const row = worksheet.getRow(r);
    const values = [];
    for (let c = 1; c <= columnCount; c += 1) {
      values.push(normalizeCellValue(row.getCell(c).value));
    }
    if (includeEmpty || values.some((v) => String(v ?? '').trim())) {
      rows.push(values);
    }
  }

  return rows;
}

function worksheetToObjects(worksheet) {
  const rows = worksheetToRows(worksheet);
  if (!rows.length) return [];

  const headers = rows[0].map((h, idx) => {
    const header = String(h ?? '').replace(/\s+/g, ' ').trim();
    return header || `col_${idx}`;
  });

  return rows.slice(1)
    .filter((row) => row.some((v) => String(v ?? '').trim()))
    .map((row) => {
      const obj = {};
      headers.forEach((header, idx) => {
        obj[header] = row[idx] ?? '';
      });
      return obj;
    });
}

function worksheetToCsv(worksheet) {
  const rows = worksheetToRows(worksheet, { includeEmpty: false });
  return rows.map((row) => row.map((value) => {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }).join(',')).join('\n');
}

function worksheetCells(worksheet, { maxCells = Infinity } = {}) {
  const cells = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (cells.length >= maxCells) return;
      const value = normalizeCellValue(cell.value);
      cells.push({
        address: cellAddress(rowNumber, colNumber),
        rowNumber,
        colNumber,
        value,
        text: cell.text || String(value ?? ''),
      });
    });
  });
  return cells;
}

async function loadWorkbookFromBuffer(buffer, { filename = '', contentType = '' } = {}) {
  const lower = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const workbook = new ExcelJS.Workbook();

  if (lower.endsWith('.csv') || ct.includes('csv')) {
    const text = Buffer.from(buffer || Buffer.alloc(0)).toString('utf8');
    const stream = require('stream');
    await workbook.csv.read(stream.Readable.from([text]));
    return workbook;
  }

  if (lower.endsWith('.xls') && !lower.endsWith('.xlsx')) {
    throw new Error('Legacy .xls files are not supported. Please upload .xlsx or .csv.');
  }

  await workbook.xlsx.load(buffer);
  return workbook;
}

module.exports = {
  cellAddress,
  columnName,
  loadWorkbookFromBuffer,
  normalizeCellValue,
  worksheetCells,
  worksheetToCsv,
  worksheetToObjects,
  worksheetToRows,
};
