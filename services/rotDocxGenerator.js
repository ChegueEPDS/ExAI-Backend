// services/rotDocxGenerator.js
const JSZip = require('jszip');

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function replaceWTByIndex(xml, indexToValue) {
  let idx = 0;
  return xml.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (m, attrs, inner) => {
    const key = idx++;
    if (!Object.prototype.hasOwnProperty.call(indexToValue, key)) return m;
    const val = indexToValue[key];
    return `<w:t${attrs}>${escapeXml(val)}</w:t>`;
  });
}

function findWTTexts(xml) {
  const out = [];
  let m;
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function buildIndexMapForRange(startIdx, endIdxExclusive, firstVal) {
  const m = {};
  m[startIdx] = firstVal;
  for (let i = startIdx + 1; i < endIdxExclusive; i++) m[i] = '';
  return m;
}

function findRangeAfterLabel(texts, labelPred, stopPred, maxScan = 250) {
  const i = texts.findIndex((t) => labelPred(normalizeText(t)));
  if (i === -1) return null;
  const start = i + 1;
  let end = start;
  const limit = Math.min(texts.length, start + maxScan);
  for (let j = start; j < limit; j++) {
    const nt = normalizeText(texts[j]);
    if (stopPred(nt)) break;
    end = j + 1;
  }
  if (end <= start) return null;
  return { labelIdx: i, start, end };
}

function findIndexByPhrase(texts, phrase, window = 8) {
  const p = String(phrase || '').toLowerCase();
  if (!p) return -1;
  for (let i = 0; i < texts.length; i++) {
    let combined = '';
    for (let j = 0; j < window && i + j < texts.length; j++) combined += ` ${normalizeText(texts[i + j])}`;
    if (combined.toLowerCase().includes(p)) return i;
  }
  return -1;
}

function findValueRangeBetweenPhrases(texts, startPhrase, stopPhrase, opts = {}) {
  const { skipAfterStart = 6, maxScan = 350 } = opts;
  const sIdx = findIndexByPhrase(texts, startPhrase);
  if (sIdx === -1) return null;
  const start = Math.min(texts.length, sIdx + skipAfterStart);
  const stopIdx = stopPhrase ? findIndexByPhrase(texts.slice(start), stopPhrase) : -1;
  const stopAbs = stopIdx === -1 ? -1 : start + stopIdx;
  const endLimit = Math.min(texts.length, start + maxScan);
  const end = stopAbs !== -1 ? Math.min(stopAbs, endLimit) : endLimit;
  if (end <= start) return null;
  return { start, end };
}

function replaceAllTextRuns(segmentXml, newText) {
  let i = 0;
  return segmentXml.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (m, attrs) => {
    if (i++ === 0) return `<w:t${attrs}>${escapeXml(newText)}</w:t>`;
    return `<w:t${attrs}></w:t>`;
  });
}

function replaceNextTableCellAfterAnchor(xml, anchorLiteral, newText) {
  const anchor = String(anchorLiteral || '');
  const idx = xml.indexOf(anchor);
  if (idx === -1) return xml;

  const labelEnd = xml.indexOf('</w:tc>', idx);
  if (labelEnd === -1) return xml;
  const valueStart = xml.indexOf('<w:tc', labelEnd);
  if (valueStart === -1) return xml;
  const valueEnd = xml.indexOf('</w:tc>', valueStart);
  if (valueEnd === -1) return xml;

  const cell = xml.slice(valueStart, valueEnd + '</w:tc>'.length);
  const updated = replaceAllTextRuns(cell, newText);
  return xml.slice(0, valueStart) + updated + xml.slice(valueEnd + '</w:tc>'.length);
}

function updateCheckboxesInSegment(segmentXml, desired) {
  // desired: ['gas','dust','both'] -> which one should be checked (only one)
  const wanted = desired;
  const checks = [];
  const reChecked = /<w14:checked\b[^>]*w14:val=\"([01])\"[^>]*\/>/g;
  let m;
  while ((m = reChecked.exec(segmentXml))) {
    checks.push({ start: m.index, len: m[0].length, val: m[1], raw: m[0] });
  }
  if (checks.length < 3) return segmentXml;

  // Replace in order: gas, dust, both
  let out = segmentXml;
  // Also update glyphs (☐/☒) in the sdtContent runs inside the same order
  // We do a simple sequential replacement over the first 3 checkbox glyph occurrences.
  let glyphIdx = 0;
  out = out.replace(/<w:t>([☐☒])<\/w:t>/g, (mm) => {
    if (glyphIdx >= 3) return mm;
    const which = ['gas', 'dust', 'both'][glyphIdx++];
    const checked = wanted === which;
    return `<w:t>${checked ? '☒' : '☐'}</w:t>`;
  });

  let checkIdx = 0;
  out = out.replace(/<w14:checked\b[^>]*w14:val=\"[01]\"[^>]*\/>/g, (mm) => {
    if (checkIdx >= 3) return mm;
    const which = ['gas', 'dust', 'both'][checkIdx++];
    const checked = wanted === which;
    return mm.replace(/w14:val=\"[01]\"/, `w14:val=\"${checked ? 1 : 0}\"`);
  });

  return out;
}

function updateUnitRowSegment(segmentXml, unitMeta, selectedScope) {
  // Update title (first meaningful text after the code), and checkboxes.
  const code = unitMeta.code;
  const title = unitMeta.title || '';
  const trainingType = unitMeta.trainingType || 'Full';

  // Replace title: find first <w:t> after the code that is not checkbox glyph and not 'Full'
  const texts = [];
  const matches = [];
  const re = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(segmentXml))) {
    matches.push({ start: m.index, attrs: m[1], inner: m[2], len: m[0].length });
    texts.push(m[2]);
  }

  const normalizedCode = normalizeText(code).toUpperCase();
  const codeIdx = texts.findIndex((t) => normalizeText(t).toUpperCase() === normalizedCode);
  if (codeIdx !== -1) {
    for (let i = codeIdx + 1; i < texts.length; i++) {
      const nt = normalizeText(texts[i]);
      if (!nt) continue;
      if (nt === '☐' || nt === '☒') continue;
      if (nt.toLowerCase() === normalizeText(trainingType).toLowerCase()) continue;
      // Heuristic: replace first real text as title
      const before = segmentXml.slice(0, matches[i].start);
      const after = segmentXml.slice(matches[i].start + matches[i].len);
      const replacement = `<w:t${matches[i].attrs}>${escapeXml(title || nt)}</w:t>`;
      segmentXml = before + replacement + after;
      break;
    }
  }

  // Checkboxes
  const desired =
    selectedScope === 'gas' ? 'gas' : selectedScope === 'dust' ? 'dust' : selectedScope === 'both' ? 'both' : null;
  if (!desired) {
    // none -> all unchecked
    segmentXml = updateCheckboxesInSegment(segmentXml, '__none__'); // will set all to unchecked
    segmentXml = segmentXml.replace(/<w:t>☒<\/w:t>/g, '<w:t>☐</w:t>');
    segmentXml = segmentXml.replace(/<w14:checked\b[^>]*w14:val=\"1\"[^>]*\/>/g, (mm) =>
      mm.replace(/w14:val=\"1\"/, 'w14:val="0"')
    );
    return segmentXml;
  }
  segmentXml = updateCheckboxesInSegment(segmentXml, desired);
  return segmentXml;
}

function unitCodeSortKey(code) {
  const s = String(code || '').toUpperCase().trim();
  const m = s.match(/EX\s*(\d{1,3})/);
  const n = m ? Number(m[1]) : 9999;
  return n;
}

function findMatchingTagEnd(xml, startIdx, openTag, closeTag) {
  let depth = 0;
  let i = startIdx;
  while (i < xml.length) {
    const nextOpen = xml.indexOf(openTag, i);
    const nextClose = xml.indexOf(closeTag, i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + openTag.length;
      continue;
    }
    depth--;
    i = nextClose + closeTag.length;
    if (depth <= 0) return i;
  }
  return -1;
}

function replaceUnitRowsInTemplate(xml, selectedUnits, unitMetaByCode) {
  if (!Array.isArray(selectedUnits)) return xml;
  const marker = '<w:t>Unit Code</w:t>';
  const mIdx = xml.indexOf(marker);
  if (mIdx === -1) return xml;

  const tblStart = xml.lastIndexOf('<w:tbl', mIdx);
  if (tblStart === -1) return xml;
  const tblEnd = findMatchingTagEnd(xml, tblStart, '<w:tbl', '</w:tbl>');
  if (tblEnd === -1) return xml;

  const tableXml = xml.slice(tblStart, tblEnd);
  const rows = tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  if (!rows.length) return xml;

  const unitRowIdxs = [];
  const codeToRow = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const mm = r.match(/<w:t>\s*Unit\s+EX?\s*(\d{3})\s*<\/w:t>/i);
    if (mm) {
      unitRowIdxs.push(i);
      const code = `EX ${mm[1]}`.toUpperCase();
      codeToRow[code] = r;
    }
  }
  if (!unitRowIdxs.length) return xml;

  const baseRow =
    codeToRow['EX 001'] || codeToRow['EX 003'] || rows[unitRowIdxs[0]];

  const unique = new Map();
  for (const u of selectedUnits) {
    const code = String(u?.code || '').trim().toUpperCase();
    if (!code) continue;
    if (!unique.has(code)) unique.set(code, u);
  }
  const chosen = Array.from(unique.values()).sort((a, b) => unitCodeSortKey(a.code) - unitCodeSortKey(b.code));

  const newRows = chosen.map((u) => {
    const code = String(u.code || '').trim().toUpperCase();
    const scope = u.scope || 'both';
    const meta = unitMetaByCode[code] || { code, title: '', trainingType: 'Full' };
    // Clone from existing row if present; else from base row.
    let rowXml = codeToRow[code] || baseRow;

    // Ensure the row's unit code is updated (template rows use "Unit Ex 001" style).
    rowXml = rowXml.replace(/<w:t>\s*Unit\s+Ex\s+\d{3}\s*<\/w:t>/gi, `<w:t>Unit ${escapeXml(code)}</w:t>`);

    // Patch title + checkboxes based on scope.
    rowXml = updateUnitRowSegment(rowXml, { ...meta, code }, scope);
    return rowXml;
  });

  const firstIdx = unitRowIdxs[0];
  const lastIdx = unitRowIdxs[unitRowIdxs.length - 1];
  const firstRow = rows[firstIdx];
  const lastRow = rows[lastIdx];

  const startPos = tableXml.indexOf(firstRow);
  const endPos = tableXml.indexOf(lastRow, startPos) + lastRow.length;
  if (startPos === -1 || endPos === -1) return xml;

  const replacedTableXml = tableXml.slice(0, startPos) + newRows.join('') + tableXml.slice(endPos);
  return xml.slice(0, tblStart) + replacedTableXml + xml.slice(tblEnd);
}

function computeStandardsFromUnits(selectedUnits, unitMetaByCode) {
  const parts = [];
  const seen = new Set();
  for (const u of selectedUnits || []) {
    const meta = unitMetaByCode[u.code];
    const stdRaw = meta?.standard || '';
    const std = normalizeText(stdRaw);
    if (!std) continue;
    if (seen.has(std)) continue;
    seen.add(std);
    parts.push(stdRaw);
  }
  return parts;
}

/**
 * Generate a ROT DOCX buffer by patching the template docx.
 * This is intentionally template-driven to preserve branding/layout.
 */
async function generateRotDocxBuffer({ templateBuffer, training, candidate, unitMetaByCode }) {
  const zip = await JSZip.loadAsync(templateBuffer);
  const docPath = 'word/document.xml';
  const docFile = zip.file(docPath);
  if (!docFile) throw new Error('Template DOCX missing word/document.xml');
  let xml = await docFile.async('string');

  // 1) Candidate name (after "that:" and before "completed")
  const texts = findWTTexts(xml).map((t) => t || '');
  const nameRange = findRangeAfterLabel(
    texts,
    (t) => t.toLowerCase().includes('that:'),
    (t) => t.toLowerCase().includes('completed')
  );
  if (nameRange) {
    const fullName = `${candidate.givenNames || ''} ${candidate.lastName || ''}`.trim();
    xml = replaceWTByIndex(xml, buildIndexMapForRange(nameRange.start, nameRange.end, fullName));
  }

  // 2-7) Patch label/value cells in the training meta table (template-driven)
  xml = replaceNextTableCellAfterAnchor(xml, 'Date of ', training.dateOfIssue);
  xml = replaceNextTableCellAfterAnchor(xml, 'Validity of ', `${training.validityFrom} to ${training.validityTo}`);
  if (candidate.trainingLocation) {
    xml = replaceNextTableCellAfterAnchor(xml, 'Training Location:', candidate.trainingLocation);
  }
  if (training.trainingLanguage) {
    xml = replaceNextTableCellAfterAnchor(xml, 'Training Language:', training.trainingLanguage);
  }

  const standards = computeStandardsFromUnits(candidate.units || [], unitMetaByCode);
  if (standards.length) {
    const combined = standards.map((s) => normalizeText(s)).filter(Boolean).join(', ');
    if (combined) xml = replaceNextTableCellAfterAnchor(xml, 'Standard(s):', combined);
  }

  if (training.recordOfTrainingNo) {
    xml = replaceNextTableCellAfterAnchor(xml, 'No.:', training.recordOfTrainingNo);
  }

  // 8) Unit rows: only include rows selected in the XLSX for this candidate.
  xml = replaceUnitRowsInTemplate(xml, candidate.units || [], unitMetaByCode || {});

  zip.file(docPath, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = {
  generateRotDocxBuffer
};
