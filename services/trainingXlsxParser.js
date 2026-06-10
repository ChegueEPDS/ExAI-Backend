// services/trainingXlsxParser.js
const ExcelJS = require('exceljs');

function norm(v) {
  return String(v || '').trim();
}

function isTruthyMark(v) {
  const s = norm(v).toLowerCase();
  return s === 'x' || s === 'yes' || s === 'true' || s === '1';
}

// Map of supported unit columns in the provided XLSX template.
// Candidate rows start at 11; unit headers are on rows 8-9.
// In the current XLSX template, units start at L:
// L=EX 000, M=EX 001, N/O=EX 002 gas/dust, W/X=EX 010 gas/dust, Y=EX 011.
const COLS = {
  trainingLocation: 3, // C
  givenNames: 4, // D
  lastName: 5, // E
  employer: 6, // F
  country: 7, // G
  email: 8, // H
  passportOrId: 9, // I
  phone: 10, // J
  // IECEx units (by column number)
  units: {
    'EX 000': { cols: [12], scope: 'both' }, // L
    'EX 001': { cols: [13], scope: 'both' }, // M
    'EX 002': { cols: [14, 15], scope: 'gas_dust' }, // N gas, O dust
    'EX 003': { cols: [16], scope: 'both' }, // P
    'EX 004': { cols: [17], scope: 'both' }, // Q
    'EX 005': { cols: [18], scope: 'both' }, // R
    'EX 006': { cols: [19], scope: 'both' }, // S
    'EX 007': { cols: [20], scope: 'both' }, // T
    'EX 008': { cols: [21], scope: 'both' }, // U
    'EX 009': { cols: [22], scope: 'both' }, // V
    'EX 010': { cols: [23, 24], scope: 'gas_dust' }, // W gas, X dust
    'EX 011': { cols: [25], scope: 'both' }, // Y
  }
};

/**
 * Parse the provided "tracking minta.xlsx" like file and return candidates.
 * @param {Buffer} buffer
 * @returns {Promise<{ candidates: any[], warnings: string[] }>}
 */
async function parseCandidatesFromXlsxBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Candidate Info') || wb.worksheets[0];
  if (!ws) throw new Error('XLSX: missing worksheet');

  const warnings = [];
  const candidates = [];

  // Candidate rows start at 10 in the current XLSX template.
  for (let r = 10; r <= ws.rowCount; r++) {
    const givenNames = norm(ws.getRow(r).getCell(COLS.givenNames).value);
    const lastName = norm(ws.getRow(r).getCell(COLS.lastName).value);
    const trainingLocation = norm(ws.getRow(r).getCell(COLS.trainingLocation).value);

    // stop when the sheet becomes empty
    if (!givenNames && !lastName && !trainingLocation) {
      // allow a few blank rows without stopping early
      const nextGiven = norm(ws.getRow(r + 1).getCell(COLS.givenNames).value);
      const nextLast = norm(ws.getRow(r + 1).getCell(COLS.lastName).value);
      const nextLoc = norm(ws.getRow(r + 1).getCell(COLS.trainingLocation).value);
      if (!nextGiven && !nextLast && !nextLoc) break;
      continue;
    }

    const row = ws.getRow(r);
    const unitSelections = [];

    for (const [code, spec] of Object.entries(COLS.units)) {
      if (spec.scope === 'gas_dust') {
        const gas = isTruthyMark(row.getCell(spec.cols[0]).value);
        const dust = isTruthyMark(row.getCell(spec.cols[1]).value);
        if (!gas && !dust) continue;
        unitSelections.push({
          code,
          scope: gas && dust ? 'both' : gas ? 'gas' : 'dust'
        });
      } else {
        const marked = isTruthyMark(row.getCell(spec.cols[0]).value);
        if (!marked) continue;
        unitSelections.push({ code, scope: spec.scope });
      }
    }

    candidates.push({
      rowNo: r,
      trainingLocation,
      givenNames,
      lastName,
      employer: norm(row.getCell(COLS.employer).value),
      country: norm(row.getCell(COLS.country).value),
      email: norm(row.getCell(COLS.email).value),
      passportOrId: norm(row.getCell(COLS.passportOrId).value),
      phone: norm(row.getCell(COLS.phone).value),
      units: unitSelections
    });
  }

  if (!candidates.length) warnings.push('No candidates found in XLSX (expected data starting around row 10).');
  return { candidates, warnings };
}

module.exports = {
  parseCandidatesFromXlsxBuffer
};

