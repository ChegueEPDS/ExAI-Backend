function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function extractFirstTable(html) {
  const s = String(html || '');
  const m = s.match(/<table[\s\S]*?<\/table>/i);
  return m ? m[0] : null;
}

function parseTable(html) {
  const tableHtml = extractFirstTable(html);
  if (!tableHtml) return null;

  const theadMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
  const tbodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!theadMatch || !tbodyMatch) return null;

  const headerRowMatch = theadMatch[0].match(/<tr[\s\S]*?<\/tr>/i);
  if (!headerRowMatch) return null;
  const headerCells = Array.from(headerRowMatch[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((m) =>
    stripTags(m[1])
  );

  const rowMatches = Array.from(tbodyMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((m) => m[0]);
  const rows = rowMatches.map((rowHtml) =>
    Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => stripTags(m[1]))
  );

  return { headers: headerCells, rows };
}

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexOfHeader(headers, candidates) {
  const normalized = headers.map(normalizeHeader);
  const want = (Array.isArray(candidates) ? candidates : [candidates]).map(normalizeHeader);
  for (let i = 0; i < normalized.length; i += 1) {
    if (want.includes(normalized[i])) return i;
  }
  return -1;
}

function buildEquipmentFromDataplateTable(html) {
  const parsed = parseTable(html);
  if (!parsed) return null;

  const { headers, rows } = parsed;
  if (!rows.length) return null;

  const idxEqId = indexOfHeader(headers, 'EqID');
  const idxManufacturer = indexOfHeader(headers, 'Manufacturer');
  const idxModel = indexOfHeader(headers, ['Model Type', 'Model/Type']);
  const idxSerial = indexOfHeader(headers, ['Serial Number', 'Serial No', 'S N', 'SN']);
  const idxEqType = indexOfHeader(headers, ['Equipment Type', 'Description']);
  const idxIp = indexOfHeader(headers, ['IP Rating', 'IP rating']);
  const idxCert = indexOfHeader(headers, ['Certificate No', 'Certificate No', 'Certificate No.', 'Certificate No.']);
  const idxMaxAmb = indexOfHeader(headers, ['Max Ambient Temp', 'Max Ambient Temperature']);
  const idxOther = indexOfHeader(headers, ['Other Info', 'Remarks']);
  const idxCompliance = indexOfHeader(headers, ['Compliance', 'Inspection Status']);

  const idxMarking = indexOfHeader(headers, ['ATEX IECEX Marking', 'ATEX IECEX marking', 'ATEX / IECEX Marking']);
  const idxEquipGroup = indexOfHeader(headers, 'Equipment Group');
  const idxEquipCategory = indexOfHeader(headers, 'Equipment Category');
  const idxEnvironment = indexOfHeader(headers, 'Environment');
  const idxProtection = indexOfHeader(headers, ['Type of Protection', 'Protection Type']);
  const idxGasDust = indexOfHeader(headers, ['Gas Dust Group', 'Gas / Dust Group']);
  const idxTempClass = indexOfHeader(headers, [
    'Temperature Class Max Surface Temperature',
    'Temperature Class',
    'Temperature Class / Max. Surface Temperature'
  ]);
  const idxEpl = indexOfHeader(headers, ['Equipment Protection Level', 'EPL']);

  const first = rows[0] || [];
  const get = (idx) => (idx >= 0 ? String(first[idx] || '').trim() : '');

  const exMarkings = rows.map((r) => {
    const pick = (idx) => (idx >= 0 ? String(r[idx] || '').trim() : '');
    return {
      Marking: pick(idxMarking),
      'Equipment Group': pick(idxEquipGroup),
      'Equipment Category': pick(idxEquipCategory),
      Environment: pick(idxEnvironment),
      'Type of Protection': pick(idxProtection),
      'Gas / Dust Group': pick(idxGasDust),
      'Temperature Class': pick(idxTempClass),
      'Equipment Protection Level': pick(idxEpl)
    };
  });

  const exMarkingClean = exMarkings.filter((m) =>
    Object.values(m).some((v) => String(v || '').trim().length > 0)
  );

  return {
    EqID: get(idxEqId),
    Manufacturer: get(idxManufacturer),
    'Model/Type': get(idxModel),
    'Serial Number': get(idxSerial),
    'Equipment Type': get(idxEqType) || '-',
    'IP rating': get(idxIp),
    'Certificate No': get(idxCert),
    'Max Ambient Temp': get(idxMaxAmb),
    'Other Info': get(idxOther),
    Compliance: get(idxCompliance) || 'NA',
    'Ex Marking': exMarkingClean
  };
}

module.exports = { buildEquipmentFromDataplateTable };

