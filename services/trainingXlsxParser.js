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
// Candidate rows start at 11; header rows are 7-9.
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
    'EX 001': { cols: [12], scope: 'both' }, // L
    'EX 003': { cols: [15], scope: 'both' }, // O
    'EX 004': { cols: [16], scope: 'both' }, // P
    'EX 006': { cols: [18], scope: 'both' }, // R
    'EX 007': { cols: [19], scope: 'both' }, // S
    'EX 008': { cols: [20], scope: 'both' }, // T
    // Optional in XLSX but not in the provided DOCX template:
    'EX 002': { cols: [13, 14], scope: 'gas_dust' }, // M gas, N dust
    'EX 010': { cols: [22, 23], scope: 'gas_dust' }, // V gas, W dust
    'EX 000': { cols: [11], scope: 'both' }, // K
    'EX 005': { cols: [17], scope: 'both' }, // Q
    'EX 009': { cols: [21], scope: 'both' }, // U
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

  // Candidate rows usually start at 11 (based on sample).
  for (let r = 11; r <= ws.rowCount; r++) {
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

  if (!candidates.length) warnings.push('No candidates found in XLSX (expected data starting around row 11).');
  return { candidates, warnings };
}

module.exports = {
  parseCandidatesFromXlsxBuffer
};

