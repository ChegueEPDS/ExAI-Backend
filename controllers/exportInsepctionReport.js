// controllers/exportInsepctionReport.js

const ExcelJS = require('exceljs');
const archiver = require('archiver');
const path = require('path');
const Inspection = require('../models/inspection');
const Dataplate = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const Certificate = require('../models/certificate');
const azureBlob = require('../services/azureBlobService');

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEFAULT_COLUMNS = [
  { header: '', key: 'A', width: 8 },   // A
  { header: '', key: 'B', width: 10 },  // B
  { header: '', key: 'C', width: 10 },  // C
  { header: '', key: 'D', width: 10 },  // D
  { header: '', key: 'E', width: 10 },  // E
  { header: '', key: 'F', width: 10 },  // F
  { header: '', key: 'G', width: 10 },  // G
  { header: '', key: 'H', width: 10 },  // H
  { header: '', key: 'I', width: 10 },  // I
  { header: '', key: 'J', width: 10 },  // J
  { header: '', key: 'K', width: 10 },  // K
  { header: '', key: 'L', width: 10 },  // L
  { header: '', key: 'M', width: 10 },  // M
  { header: '', key: 'N', width: 10 },  // N
  { header: '', key: 'O', width: 10 },  // O
];

const TITLE_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'ffffcc00' }
};

const HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE7E7E7' }
};

const BORDER_THIN = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
};

async function findEquipmentForInspection(inspection) {
  let equipment = null;

  // 1) Try matching by EqID stored in inspection.equipmentId (string)
  if (inspection?.equipmentId) {
    equipment = await Dataplate.findOne({ EqID: inspection.equipmentId }).lean();

    // 2) Try interpreting equipmentId as an ObjectId reference
    if (!equipment) {
      try {
        equipment = await Dataplate.findById(inspection.equipmentId).lean();
      } catch (e) {
        // Ignore cast errors
      }
    }
  }

  // 3) Fallback: try eqId snapshot field if present
  if (!equipment && inspection?.eqId) {
    equipment = await Dataplate.findOne({ EqID: inspection.eqId }).lean();
  }

  return equipment;
}

async function getSiteCached(siteId, cache) {
  if (!siteId) return null;
  const key = siteId.toString();
  if (cache && cache.has(key)) return cache.get(key);

  const site = await Site.findById(siteId).lean();
  if (cache) cache.set(key, site);
  return site;
}

async function getZoneCached(zoneId, cache) {
  if (!zoneId) return null;
  const key = zoneId.toString();
  if (cache && cache.has(key)) return cache.get(key);

  const zone = await Zone.findById(zoneId).lean();
  if (cache) cache.set(key, zone);
  return zone;
}

async function resolveSchemeFromEquipment(equipment, certificateCache) {
  let scheme = '';
  const equipmentCertNo = equipment?.['Certificate No'];

  if (!equipmentCertNo) {
    return scheme;
  }

  const cacheKey = equipmentCertNo.toUpperCase();
  if (certificateCache && certificateCache.has(cacheKey)) {
    return certificateCache.get(cacheKey);
  }

  let cert = await Certificate.findOne({ certNo: equipmentCertNo })
    .collation({ locale: 'en', strength: 2 })
    .lean();

  if (cert && cert.scheme) {
    scheme = cert.scheme;
  } else {
    const upperNo = equipmentCertNo.toUpperCase();

    const hasATEX = upperNo.includes('ATEX');
    const hasIECEX = upperNo.includes('IECEX');

    if (hasATEX && hasIECEX) {
      scheme = 'ATEX / IECEx';
    } else if (hasATEX) {
      scheme = 'ATEX';
    } else if (hasIECEX) {
      scheme = 'IECEx';
    } else {
      scheme = '';
    }
  }

  if (certificateCache) {
    certificateCache.set(cacheKey, scheme);
  }

  return scheme;
}

async function resolveInspectionContext(inspection, options = {}) {
  const {
    equipment: preloadedEquipment,
    siteCache,
    zoneCache,
    certificateCache
  } = options;

  const equipment = preloadedEquipment || await findEquipmentForInspection(inspection);
  if (!equipment) {
    return { error: 'Equipment not found' };
  }

  const site = await getSiteCached(equipment.Site, siteCache);
  const zone = await getZoneCached(equipment.Zone, zoneCache);
  const scheme = await resolveSchemeFromEquipment(equipment, certificateCache);

  return { equipment, site, zone, scheme };
}

function sanitizeFileNameSegment(value, fallback = 'item') {
  const safe = String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function deriveQuestionReference(result) {
  if (!result) return '';
  const tableVal = (result.table || result.Table || '').toString();
  const groupVal = (result.group || result.Group || '').toString();
  const numRaw = result.number ?? result.Number;
  if (tableVal === 'SC' || result.equipmentType === 'Special Condition') {
    const num = typeof numRaw === 'number' ? numRaw : 1;
    return `SC${num}`;
  }
  if (tableVal && groupVal && (numRaw || numRaw === 0)) {
    return `${tableVal}-${groupVal}-${numRaw}`;
  }
  return result.reference || '';
}

function deriveQuestionKey(result) {
  if (!result) return null;
  if (result.questionKey) return result.questionKey;
  const ref = deriveQuestionReference(result);
  return ref || null;
}

function buildResultKeys(result) {
  const keys = [];
  if (result?.questionId) {
    keys.push(`id:${result.questionId.toString()}`);
  }
  const derivedKey = deriveQuestionKey(result);
  if (derivedKey) {
    keys.push(`key:${derivedKey}`);
  }
  if (!keys.length) {
    keys.push('general');
  }
  return keys;
}

function buildInspectionAttachmentLookup(inspection, eqId) {
  const eqFolder = sanitizeFileNameSegment(eqId || inspection?.eqId || inspection?.equipmentId || 'equipment');
  const attachments = Array.isArray(inspection?.attachments) ? inspection.attachments : [];
  const imageAttachments = attachments.filter(att => att && att.blobPath && (att.type === 'image' || !att.type));
  const byKey = new Map();
  const counterMap = new Map();
  const metas = [];

  imageAttachments.forEach((att, index) => {
    const keys = [];
    if (att.questionId) keys.push(`id:${att.questionId.toString()}`);
    if (att.questionKey) keys.push(`key:${att.questionKey}`);
    if (!keys.length) keys.push('general');

    const preferredKey = att.questionKey || (keys.find(k => k.startsWith('key:'))?.slice(4)) || `IMG${index + 1}`;
    const sanitizedKey = sanitizeFileNameSegment(preferredKey, 'img');
    const counterKey = `${sanitizedKey}`;
    const seq = (counterMap.get(counterKey) || 0) + 1;
    counterMap.set(counterKey, seq);
    const ext = path.extname(att.blobPath) || '.jpg';
    const padded = seq.toString().padStart(2, '0');
    const fileName = `${eqFolder}_${sanitizedKey}_${padded}${ext}`;
    const meta = { ...att, fileName, keys, eqFolder };
    metas.push(meta);
    keys.forEach(key => {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(meta);
    });
  });

  const getForResult = (result) => {
    if (!result) return [];
    const keys = buildResultKeys(result);
    const seen = new Set();
    const list = [];
    keys.forEach(key => {
      const arr = byKey.get(key);
      if (arr) {
        arr.forEach(meta => {
          if (seen.has(meta.fileName)) return;
          seen.add(meta.fileName);
          list.push(meta);
        });
      }
    });
    return list;
  };

  return {
    all: metas,
    eqFolder,
    getForResult,
    getFileNamesForResult: (result) => getForResult(result).map(meta => meta.fileName)
  };
}

async function appendImagesToArchive(archive, attachments, imagesRoot = 'images') {
  if (!Array.isArray(attachments) || !attachments.length) return;
  for (const meta of attachments) {
    if (!meta?.blobPath) continue;
    try {
      const buffer = await azureBlob.downloadToBuffer(meta.blobPath);
      const folder = sanitizeFileNameSegment(meta.eqFolder || 'equipment');
      const zipPath = path.posix.join(imagesRoot, folder, meta.fileName);
      archive.append(buffer, { name: zipPath });
    } catch (err) {
      console.error('⚠️ Failed to append inspection image to archive:', err?.message || err);
    }
  }
}

function buildInspectionWorkbook(inspection, equipment, site, zone, scheme, attachmentLookup = null) {
  // -------- Excel workbook + sheet --------
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Inspection Report');

  const setHeaderCell = (range, text) => {
    ws.mergeCells(range);
    const cell = ws.getCell(range.split(':')[0]);
    cell.value = text;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = HEADER_FILL;
    return cell;
  };

  const setValueCell = (range, value) => {
    ws.mergeCells(range);
    const cell = ws.getCell(range.split(':')[0]);
    cell.value = value || '';
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    return cell;
  };

  // Oszlopszélességek – kb. a tervhez igazítva
  ws.columns = DEFAULT_COLUMNS;

  const inspectionDate = inspection.inspectionDate
    ? new Date(inspection.inspectionDate)
    : new Date();

  const inspectorName = inspection.inspectorId
    ? `${inspection.inspectorId.firstName || ''} ${inspection.inspectorId.lastName || ''}`.trim()
    : '';

  // ========= 1. sor – cím + dátum =========
  ws.mergeCells('A1:K2');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'Inspection Test Report';
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = TITLE_FILL;

  ws.mergeCells('L1:L2');
  ws.getCell('L1').value = 'Date:';
  ws.getCell('L1').font = { bold: true, size: 16 };
  ws.getCell('L1').alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getCell('L1').fill= HEADER_FILL;

  ws.mergeCells('M1:N2');
  ws.getCell('M1').value = inspectionDate;
  ws.getCell('M1').font = { size: 16 };
  ws.getCell('M1').numFmt = 'yyyy-mm-dd';
  ws.getCell('M1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('M1').fill= HEADER_FILL;

  // üres sor (3)
  const emptyRow3 = ws.addRow([]);
  emptyRow3.height = 7;

  let currentRow = 4;
  const topRowHeight = 30;
  const spacerHeight = 5;

  // Client / Project / Zone
  const clientRow = currentRow;
  setHeaderCell(`A${clientRow}:B${clientRow}`, 'Client name');
  setValueCell(`C${clientRow}:E${clientRow}`, site?.Client || '');
  setHeaderCell(`F${clientRow}:G${clientRow}`, 'Project');
  setValueCell(`H${clientRow}:J${clientRow}`, site?.Name || '');
  setHeaderCell(`K${clientRow}:L${clientRow}`, 'Zone');
  setValueCell(`M${clientRow}:N${clientRow}`, zone?.Name || zone?.ZoneName || '');
  ws.getRow(clientRow).height = topRowHeight;
  currentRow += 1;

  const tagIdValue = equipment?.TagNo || equipment?.['TagNo'] || equipment?.['Tag No'] || equipment?.tagId || '';
  const hasTagId = !!tagIdValue;
  let tagRowIndex = null;

  if (hasTagId) {
    tagRowIndex = currentRow;
    setHeaderCell(`A${tagRowIndex}:B${tagRowIndex}`, 'Tag ID');
    setValueCell(`C${tagRowIndex}:E${tagRowIndex}`, tagIdValue);

    setHeaderCell(`F${tagRowIndex}:G${tagRowIndex}`, 'Equipment ID');
    setValueCell(`H${tagRowIndex}:J${tagRowIndex}`, equipment.EqID || '');

    setHeaderCell(`K${tagRowIndex}:L${tagRowIndex}`, 'Equipment Description');
    setValueCell(`M${tagRowIndex}:N${tagRowIndex}`, equipment['Equipment Type'] || equipment.EquipmentType || '');
    ws.getRow(tagRowIndex).height = topRowHeight;
    currentRow += 1;
  }

  const equipmentRow = currentRow;
  if (hasTagId) {
    setHeaderCell(`A${equipmentRow}:B${equipmentRow}`, 'Manufacturer');
    setValueCell(`C${equipmentRow}:E${equipmentRow}`, equipment.Manufacturer || '');
    setHeaderCell(`F${equipmentRow}:G${equipmentRow}`, 'Model');
    setValueCell(`H${equipmentRow}:J${equipmentRow}`, equipment['Model/Type'] || '');
    setHeaderCell(`K${equipmentRow}:L${equipmentRow}`, 'Serial No');
    setValueCell(`M${equipmentRow}:N${equipmentRow}`, equipment['Serial Number'] || equipment.SerialNumber || '');
  } else {
    setHeaderCell(`A${equipmentRow}:B${equipmentRow}`, 'Equipment ID');
    setValueCell(`C${equipmentRow}:E${equipmentRow}`, equipment.EqID || '');
    setHeaderCell(`F${equipmentRow}:G${equipmentRow}`, 'Manufacturer');
    setValueCell(`H${equipmentRow}:J${equipmentRow}`, equipment.Manufacturer || '');
    setHeaderCell(`K${equipmentRow}:L${equipmentRow}`, 'Model');
    setValueCell(`M${equipmentRow}:N${equipmentRow}`, equipment['Model/Type'] || '');
  }
  ws.getRow(equipmentRow).height = topRowHeight;
  currentRow += 1;

  // ========= Certificate / Ex scheme =========
  const certificateRow = currentRow;
  setHeaderCell(`A${certificateRow}:B${certificateRow}`, 'Certificate no');
  setValueCell(`C${certificateRow}:E${certificateRow}`, equipment['Certificate No'] || '');
  setHeaderCell(`F${certificateRow}:G${certificateRow}`, 'Ex scheme');
  setValueCell(`H${certificateRow}:J${certificateRow}`, scheme || '');
  setHeaderCell(`K${certificateRow}:L${certificateRow}`, 'Status');
  const statusValue = inspection.status || '';
  const isPassed = statusValue === 'Passed';
  const isFailed = statusValue === 'Failed';
  setValueCell(`M${certificateRow}:N${certificateRow}`, statusValue);
  const statusCell = ws.getCell(`M${certificateRow}`);
  statusCell.value = statusValue;
  statusCell.font = {
    bold: true,
    color: isPassed
      ? { argb: 'FF008000' }  // green
      : isFailed
        ? { argb: 'FFFF0000' } // red
        : undefined
  };
  ws.getRow(certificateRow).height = topRowHeight;
  currentRow += 1;

  // üres sor
  const spacerRowIndex = currentRow;
  const spacerRow = ws.getRow(spacerRowIndex);
  spacerRow.height = spacerHeight;
  currentRow += 1;

  // ========= Area vs Equipment =========

  // Segéd: Area sorhoz Temp Class mező (TempClass + MaxTemp, ha van)
  const zoneNumber =
    Array.isArray(zone?.Zone) && zone.Zone.length > 0
      ? zone.Zone.join(', ')
      : zone?.Zone || '';

  const zoneSubGroup = Array.isArray(zone?.SubGroup)
    ? zone.SubGroup.join(', ')
    : zone?.SubGroup || '';

  const zoneTempClass = zone?.TempClass || '';
  const zoneMaxTemp = zone?.MaxTemp ?? '';

  const zoneTempParts = [];
  if (zoneTempClass) zoneTempParts.push(zoneTempClass);
  if (zoneMaxTemp !== '' && zoneMaxTemp !== null && zoneMaxTemp !== undefined) {
    zoneTempParts.push(`${zoneMaxTemp}°C`);
  }
  const zoneTempDisplay = zoneTempParts.join(' / ');

  const ambientMin = zone?.AmbientTempMin;
  const ambientMax = zone?.AmbientTempMax;
  const ambientParts = [];
  if (ambientMin !== null && ambientMin !== undefined) {
    ambientParts.push(`${ambientMin}°C`);
  }
  if (ambientMax !== null && ambientMax !== undefined) {
    ambientParts.push(`${ambientMax}°C`);
  }
  const ambientDisplay = ambientParts.join(' - ');

  const zoneIpRating = zone?.IpRating || '';
  const zoneEpl = Array.isArray(zone?.EPL)
    ? zone.EPL.join(', ')
    : (zone?.EPL || '');

  const areaLabelFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF99' } // halvány sárga
  };

  const equipmentLabelFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFCCFFFF' } // halvány kék
  };

  const areaRow = currentRow;
  ws.mergeCells(`A${areaRow}:B${areaRow}`);
  ws.getCell(`A${areaRow}`).value = 'Area';
  ws.getCell(`A${areaRow}`).font = { bold: true };
  ws.getCell(`A${areaRow}`).fill = areaLabelFill;

  ws.getCell(`C${areaRow}`).value = 'Zone';
  ws.getCell(`C${areaRow}`).font = { bold: true };
  ws.getCell(`C${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`D${areaRow}`).value = zoneNumber || '';

  ws.getCell(`E${areaRow}`).value = 'Group';
  ws.getCell(`E${areaRow}`).font = { bold: true };
  ws.getCell(`E${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`F${areaRow}`).value = zoneSubGroup || '';

  ws.getCell(`G${areaRow}`).value = 'Temp Class';
  ws.getCell(`G${areaRow}`).font = { bold: true };
  ws.getCell(`G${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`H${areaRow}`).value = zoneTempDisplay || '';

  ws.getCell(`I${areaRow}`).value = 'Tamb';
  ws.getCell(`I${areaRow}`).font = { bold: true };
  ws.getCell(`I${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`J${areaRow}`).value = ambientDisplay || '';

  ws.getCell(`K${areaRow}`).value = 'IP Rating';
  ws.getCell(`K${areaRow}`).font = { bold: true };
  ws.getCell(`K${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`L${areaRow}`).value = zoneIpRating;

  ws.getCell(`M${areaRow}`).value = 'EPL';
  ws.getCell(`M${areaRow}`).font = { bold: true };
  ws.getCell(`M${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`N${areaRow}`).value = zoneEpl;

  const equipmentInfoRow = areaRow + 1;
  const exMarking = Array.isArray(equipment['Ex Marking'])
    ? equipment['Ex Marking'][0] || {}
    : {};

  ws.mergeCells(`A${equipmentInfoRow}:B${equipmentInfoRow}`);
  ws.getCell(`A${equipmentInfoRow}`).value = 'Equipment';
  ws.getCell(`A${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`A${equipmentInfoRow}`).fill = equipmentLabelFill;

  ws.getCell(`C${equipmentInfoRow}`).value = 'Ex Type';
  ws.getCell(`C${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`C${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`D${equipmentInfoRow}`).value = exMarking['Type of Protection'] || '';

  ws.getCell(`E${equipmentInfoRow}`).value = 'Group';
  ws.getCell(`E${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`E${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`F${equipmentInfoRow}`).value = exMarking['Gas / Dust Group'] || '';

  ws.getCell(`G${equipmentInfoRow}`).value = 'Temp Rating';
  ws.getCell(`G${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`G${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`H${equipmentInfoRow}`).value = exMarking['Temperature Class'] || '';

  ws.getCell(`I${equipmentInfoRow}`).value = 'Tamb';
  ws.getCell(`I${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`I${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`J${equipmentInfoRow}`).value = equipment['Max Ambient Temp'] || '';

  ws.getCell(`K${equipmentInfoRow}`).value = 'IP Rating';
  ws.getCell(`K${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`K${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`L${equipmentInfoRow}`).value = equipment['IP rating'] || '';

  ws.getCell(`M${equipmentInfoRow}`).value = 'EPL';
  ws.getCell(`M${equipmentInfoRow}`).font = { bold: true };
  ws.getCell(`M${equipmentInfoRow}`).fill = HEADER_FILL;
  ws.getCell(`N${equipmentInfoRow}`).value = exMarking['Equipment Protection Level'] || '';
  ws.getRow(areaRow).height = topRowHeight;
  ws.getRow(equipmentInfoRow).height = topRowHeight;

  const borderRows = [clientRow, equipmentRow, certificateRow, areaRow, equipmentInfoRow];
  if (hasTagId && tagRowIndex) borderRows.splice(1, 0, tagRowIndex);

  // Keret + igazítás
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
    borderRows.forEach(rn => {
      const cell = ws.getCell(`${col}${rn}`);
      cell.border = BORDER_THIN;
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true
      };
    });
  });

  const spacerAfterBlockIndex = equipmentInfoRow + 1;
  const spacerAfterBlock = ws.getRow(spacerAfterBlockIndex);
  spacerAfterBlock.height = spacerHeight;

  // enforce heights again (some cells wrap)
  const enforceHeights = [clientRow, equipmentRow, certificateRow, areaRow, equipmentInfoRow];
  if (hasTagId && tagRowIndex) enforceHeights.splice(1, 0, tagRowIndex);
  enforceHeights.forEach(rn => {
    const row = ws.getRow(rn);
    row.height = topRowHeight;
  });
  ws.getRow(spacerRowIndex).height = spacerHeight;
  ws.getRow(spacerAfterBlockIndex).height = spacerHeight;

  // ========= INSPECTION RESULT BLOKKOK =========

  const grouped = {};
  if (Array.isArray(inspection.results)) {
    inspection.results.forEach(r => {
      const groupName = r.equipmentType || r.questionGroup || 'General';
      if (!grouped[groupName]) grouped[groupName] = [];
      grouped[groupName].push(r);
    });
  }

  // Rendezés ugyanúgy, mint a frontenden: table -> group -> number
  Object.keys(grouped).forEach(groupKey => {
    grouped[groupKey].sort((a, b) => {
      const tableA = (a.table || a.Table || '').toString();
      const tableB = (b.table || b.Table || '').toString();
      if (tableA !== tableB) {
        return tableA.localeCompare(tableB, undefined, { numeric: true, sensitivity: 'base' });
      }

      const groupA = (a.group || a.Group || '').toString();
      const groupB = (b.group || b.Group || '').toString();
      if (groupA !== groupB) {
        return groupA.localeCompare(groupB, undefined, { numeric: true, sensitivity: 'base' });
      }

      const numA = (typeof a.number === 'number' ? a.number : (typeof a.Number === 'number' ? a.Number : 0));
      const numB = (typeof b.number === 'number' ? b.number : (typeof b.Number === 'number' ? b.Number : 0));
      return numA - numB;
    });
  });

  // Preferred group order as in frontend
  const preferredGroupOrder = [
    'General',
    'Motors',
    'Lighting',
    'Installation',
    'Installation Heating System',
    'Installation Motors',
    'Environment',
    'Uncategorized'
  ];

  const sortedGroupNames = Object.keys(grouped).sort((a, b) => {
    const indexA = preferredGroupOrder.indexOf(a);
    const indexB = preferredGroupOrder.indexOf(b);

    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }

    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;

    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  // Segéd stílus: group header
  const groupHeaderFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9D9D9' }
  };

  sortedGroupNames.forEach(groupName => {
    // Csoportcím sor – teljes szélesség merge
    const groupRow = ws.addRow([groupName]);
    const gr = groupRow.number;
    ws.mergeCells(`A${gr}:N${gr}`);

    // A teljes sor (A–N) formázása
    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${gr}`);
      cell.font = { bold: true };
      cell.fill = groupHeaderFill;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = BORDER_THIN;
    });

    // Header sor (Ref / Check / Passed / Failed / NA / Comment)
    const headerRow = ws.addRow([
      'Ref',
      'Check',
      '',
      '',
      '',
      '',
      'Passed',
      'Failed',
      'NA',
      'Comment'
    ]);
    const hr = headerRow.number;

    ws.mergeCells(`B${hr}:F${hr}`); // Check
    ws.mergeCells(`J${hr}:N${hr}`); // Comment

    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${hr}`);
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = BORDER_THIN;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    // Kérdések
    grouped[groupName].forEach(r => {
      const ref = deriveQuestionReference(r);
      const status = r.status || r.result || ''; // Passed / Failed / NA

      const passedMark = status === 'Passed' ? 'X' : '';
      const failedMark = status === 'Failed' ? 'X' : '';
      const naMark = status === 'NA' ? 'X' : '';

      const questionText =
        (r.questionText && (r.questionText.hu || r.questionText.eng)) ||
        r.question ||
        '';

      const imageNames = attachmentLookup ? attachmentLookup.getFileNamesForResult(r) : [];
      const baseComment = r.note || '';
      const commentWithImages = imageNames.length
        ? (baseComment ? `${baseComment}\nImages: ${imageNames.join(', ')}` : `Images: ${imageNames.join(', ')}`)
        : baseComment;

      const row = ws.addRow([
        ref,
        questionText,
        '',
        '',
        '',
        '',
        passedMark,
        failedMark,
        naMark,
        commentWithImages
      ]);

      const rn = row.number;

      // Merge check & comment cell blocks
      ws.mergeCells(`B${rn}:F${rn}`);
      ws.mergeCells(`J${rn}:N${rn}`);

      // Border + igazítás a sorra
      ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
        const cell = ws.getCell(`${col}${rn}`);
        cell.border = BORDER_THIN;
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
      });

      // A kérdés (Check) és a Comment cella legyen balra igazítva a merge után
      const checkCell = ws.getCell(`B${rn}`);   // B–F merge anchor
      checkCell.alignment = {
        horizontal: 'left',
        vertical: 'middle',
        wrapText: true
      };

      const commentCell = ws.getCell(`J${rn}`); // J–N merge anchor
      commentCell.alignment = {
        horizontal: 'left',
        vertical: 'middle',
        wrapText: true
      };

      // Sor magasság becslése a kérdés hossza alapján,
      // hogy a teljes szöveg látható legyen több sorban is.
      const approxCharsPerLine = 65; // kb. ennyi karakter fér el egy sorban
      const textLength = (questionText?.length || 0) + (commentWithImages?.length || 0) || 1;
      const lineCount = Math.max(1, Math.ceil(textLength / approxCharsPerLine));
      ws.getRow(rn).height = lineCount * 15; // 15 pont / sor, szükség esetén növelhető
    });

    // Üres sor a csoportok között
    const emptyRowBetweenGroups = ws.addRow([]);
    emptyRowBetweenGroups.height = 7;
  });

  // ===== FOOTER: Created by / Signature =====

  const footerRow = ws.addRow([]);
  const fr = footerRow.number;    
  ws.getRow(fr).height = 45;

  // Left block: Created by
  ws.mergeCells(`A${fr}:G${fr}`);
  const createdByCell = ws.getCell(`A${fr}`);
  createdByCell.value = inspectorName ? `Created by: ${inspectorName}` : 'Created by:';
  createdByCell.font = { bold: true, size: 16 };
  createdByCell.alignment = { horizontal: 'center', vertical: 'middle' };
  createdByCell.border = BORDER_THIN;

  // Right block: Signature
  ws.mergeCells(`H${fr}:N${fr}`);
  const signatureCell = ws.getCell(`H${fr}`);
  signatureCell.value = 'Signature: ____________________________';
  signatureCell.font = { bold: true, size: 16 }; //color: { argb: 'dedede' },
  signatureCell.alignment = { horizontal: 'center', vertical: 'middle' };
  signatureCell.border = BORDER_THIN;

  // Végső finomhangolás: magasság a felső sorokra
  /*[1,2,4,5,6,8,9].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = 30;
  });*/

  const fileName = `Inspection_EQ_${equipment.EqID || 'unknown'}_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

function buildPunchlistWorkbook({ site, zone, failures, reportDate, scopeLabel }) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Punchlist');

  ws.columns = DEFAULT_COLUMNS;

  const dateValue = reportDate ? new Date(reportDate) : new Date();

  // ========= 1–4. sor – megegyezik az ITR fejlécével =========
  ws.mergeCells('A1:K2');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'Punchlist Report';
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = TITLE_FILL;

  ws.mergeCells('L1:L2');
  ws.getCell('L1').value = 'Date:';
  ws.getCell('L1').font = { bold: true, size: 16 };
  ws.getCell('L1').alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getCell('L1').fill = HEADER_FILL;

  ws.mergeCells('M1:N2');
  ws.getCell('M1').value = dateValue;
  ws.getCell('M1').font = { size: 16 };
  ws.getCell('M1').numFmt = 'yyyy-mm-dd';
  ws.getCell('M1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('M1').fill = HEADER_FILL;

  const emptyRow3 = ws.addRow([]);
  emptyRow3.height = 7;

  ws.mergeCells('A4:B4');
  ws.getCell('A4').value = 'Client name';
  ws.getCell('A4').font = { bold: true };
  ws.getCell('A4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('A4').fill = HEADER_FILL;

  ws.mergeCells('C4:E4');
  ws.getCell('C4').value = site?.Client || '';
  ws.getCell('C4').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('F4:G4');
  ws.getCell('F4').value = 'Project';
  ws.getCell('F4').font = { bold: true };
  ws.getCell('F4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('F4').fill = HEADER_FILL;

  ws.mergeCells('H4:J4');
  ws.getCell('H4').value = site?.Name || '';
  ws.getCell('H4').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('K4:L4');
  ws.getCell('K4').value = 'Zone';
  ws.getCell('K4').font = { bold: true };
  ws.getCell('K4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('K4').fill = HEADER_FILL;

  ws.mergeCells('M4:N4');
  ws.getCell('M4').value = zone?.Name || zone?.ZoneName || (site ? 'All zones' : '');
  ws.getCell('M4').alignment = { horizontal: 'center', vertical: 'middle' };

  // Keret + magasság a fejléc soraira
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
    const cell = ws.getCell(`${col}4`);
    cell.border = BORDER_THIN;
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true
    };
  });

  [1,2,4].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = 30;
  });

  // ========= Area blokk az ITR-ből (közvetlenül a fejléc után) =========
  if (zone) {
    const zoneNumber =
      Array.isArray(zone.Zone) && zone.Zone.length > 0
        ? zone.Zone.join(', ')
        : zone.Zone || '';

    const zoneSubGroup = Array.isArray(zone.SubGroup)
      ? zone.SubGroup.join(', ')
      : zone.SubGroup || '';

    const zoneTempClass = zone.TempClass || '';
    const zoneMaxTemp = zone.MaxTemp ?? '';

    const zoneTempParts = [];
    if (zoneTempClass) zoneTempParts.push(zoneTempClass);
    if (zoneMaxTemp !== '' && zoneMaxTemp !== null && zoneMaxTemp !== undefined) {
      zoneTempParts.push(`${zoneMaxTemp}°C`);
    }
    const zoneTempDisplay = zoneTempParts.join(' / ');

    const ambientMin = zone.AmbientTempMin;
    const ambientMax = zone.AmbientTempMax;
    const ambientParts = [];
    if (ambientMin !== null && ambientMin !== undefined) {
      ambientParts.push(`${ambientMin}°C`);
    }
    if (ambientMax !== null && ambientMax !== undefined) {
      ambientParts.push(`${ambientMax}°C`);
    }
    const ambientDisplay = ambientParts.join(' - ');

    const zoneIpRating = zone.IpRating || '';
    const zoneEpl = Array.isArray(zone.EPL)
      ? zone.EPL.join(', ')
      : (zone.EPL || '');

    const areaLabelFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF99' } // halvány sárga
    };

    const areaRow = ws.addRow([]);
    const ar = areaRow.number;

    ws.getCell(`A${ar}`).value = 'Area';
    ws.mergeCells(`A${ar}:B${ar}`);
    ws.getCell(`A${ar}`).font = { bold: true };
    ws.getCell(`A${ar}`).fill = areaLabelFill;

    ws.getCell(`C${ar}`).value = 'Zone';
    ws.getCell(`C${ar}`).font = { bold: true };
    ws.getCell(`C${ar}`).fill = HEADER_FILL;
    ws.getCell(`D${ar}`).value = zoneNumber || '';

    ws.getCell(`E${ar}`).value = 'Group';
    ws.getCell(`E${ar}`).font = { bold: true };
    ws.getCell(`E${ar}`).fill = HEADER_FILL;
    ws.getCell(`F${ar}`).value = zoneSubGroup || '';

    ws.getCell(`G${ar}`).value = 'Temp Class';
    ws.getCell(`G${ar}`).font = { bold: true };
    ws.getCell(`G${ar}`).fill = HEADER_FILL;
    ws.getCell(`H${ar}`).value = zoneTempDisplay || '';

    ws.getCell(`I${ar}`).value = 'Tamb';
    ws.getCell(`I${ar}`).font = { bold: true };
    ws.getCell(`I${ar}`).fill = HEADER_FILL;
    ws.getCell(`J${ar}`).value = ambientDisplay || '';

    ws.getCell(`K${ar}`).value = 'IP Rating';
    ws.getCell(`K${ar}`).font = { bold: true };
    ws.getCell(`K${ar}`).fill = HEADER_FILL;
    ws.getCell(`L${ar}`).value = zoneIpRating;

    ws.getCell(`M${ar}`).value = 'EPL';
    ws.getCell(`M${ar}`).font = { bold: true };
    ws.getCell(`M${ar}`).fill = HEADER_FILL;
    ws.getCell(`N${ar}`).value = zoneEpl;

    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${ar}`);
      cell.border = BORDER_THIN;
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true
      };
    });

    ws.getRow(ar).height = 30;

    const emptyAfterArea = ws.addRow([]);
    emptyAfterArea.height = 7;
  }

  // ========= Punchlist tábla =========
  // Oszlopszélességek finomhangolása a merge-ekhez
  ws.getColumn('A').width = 14;
  ws.getColumn('B').width = 4;
  ws.getColumn('C').width = 10;
  ['D','E','F','G','H'].forEach(c => ws.getColumn(c).width = 18);
  ['I','J','K','L'].forEach(c => ws.getColumn(c).width = 18);
  ['M','N'].forEach(c => ws.getColumn(c).width = 10);

  const headerValues = [];
  headerValues[1] = 'Eszköz ID'; // A
  headerValues[3] = 'Ref';       // C
  headerValues[4] = 'Check';     // D
  headerValues[9] = 'Note';      // I
  headerValues[13] = 'Images';   // M

  const headerRow = ws.addRow(headerValues);
  const hr = headerRow.number;

  // Merge-ek: A-B, D-H, I-L, M-N
  ws.mergeCells(`A${hr}:B${hr}`);
  ws.mergeCells(`D${hr}:H${hr}`);
  ws.mergeCells(`I${hr}:L${hr}`);
  ws.mergeCells(`M${hr}:N${hr}`);

  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
    const cell = ws.getCell(`${col}${hr}`);
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = BORDER_THIN;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  const sortedFailures = [...failures].sort((a, b) => {
    const eqA = (a.eqId || '').toString().toLowerCase();
    const eqB = (b.eqId || '').toString().toLowerCase();
    if (eqA !== eqB) return eqA.localeCompare(eqB);
    return (a.ref || '').toString().localeCompare((b.ref || '').toString(), undefined, { numeric: true, sensitivity: 'base' });
  });

  sortedFailures.forEach(item => {
    const rowValues = [];
    rowValues[1] = item.eqId || '';      // A (merged A-B)
    rowValues[3] = item.ref || '';       // C
    rowValues[4] = item.check || '';     // D (merged D-H)
    rowValues[9] = item.note || '';      // I (merged I-L)
    rowValues[13] = Array.isArray(item.imageNames) && item.imageNames.length
      ? item.imageNames.join(', ')
      : ''; // M (merged M-N)

    const row = ws.addRow(rowValues);
    const rn = row.number;

    // Merge same regions as header
    ws.mergeCells(`A${rn}:B${rn}`);
    ws.mergeCells(`D${rn}:H${rn}`);
    ws.mergeCells(`I${rn}:L${rn}`);
    ws.mergeCells(`M${rn}:N${rn}`);

    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${rn}`);
      cell.border = BORDER_THIN;
      cell.alignment = {
        horizontal: (col >= 'D' && col <= 'H') || (col >= 'I' && col <= 'L')
          ? 'left'
          : 'center',
        vertical: 'middle',
        wrapText: true
      };
    });

    const checkText = item.check || '';
    const noteText = item.note || '';
    const imageText = Array.isArray(item.imageNames) ? item.imageNames.join(', ') : '';
    const textLength = Math.max(checkText.length, noteText.length, imageText.length, 1);
    const lineCount = Math.max(1, Math.ceil(textLength / 60));
    ws.getRow(rn).height = lineCount * 15;
  });

  const fileName = `Punchlist_${site?.Name || zone?.Name || 'report'}_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

exports.exportInspectionXLSX = async (req, res) => {
  try {
    const { id } = req.params;
    const includeImages = req.query?.includeImages === 'true';

    const inspection = await Inspection.findById(id)
      .populate('inspectorId', 'firstName lastName email')
      .lean();

    if (!inspection) {
      return res.status(404).json({ message: 'Inspection not found' });
    }

    const context = await resolveInspectionContext(inspection);

    if (context.error) {
      return res.status(404).json({ message: context.error });
    }

    const eqIdentifier = context.equipment?.EqID || inspection.eqId || inspection.equipmentId;
    const attachmentLookup = includeImages
      ? buildInspectionAttachmentLookup(inspection, eqIdentifier)
      : null;

    const { workbook, fileName } = buildInspectionWorkbook(
      inspection,
      context.equipment,
      context.site,
      context.zone,
      context.scheme,
      attachmentLookup
    );

    if (!includeImages) {
      res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const zipName = fileName.replace(/\.xlsx$/i, '') + '.zip';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('Error creating inspection ZIP:', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    archive.pipe(res);
    archive.append(workbookBuffer, { name: fileName });
    if (attachmentLookup?.all?.length) {
      await appendImagesToArchive(archive, attachmentLookup.all);
    }
    await archive.finalize();
  } catch (err) {
    console.error('Error exporting inspection XLSX:', err);
    return res.status(500).json({ message: 'Failed to export inspection report', error: err.message });
  }
};

exports.exportPunchlistXLSX = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { siteId, zoneId } = req.query || {};
    const includeImages = (req.query?.includeImages ?? 'true') !== 'false';

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!siteId && !zoneId) {
      return res.status(400).json({ message: 'Kérjük adjon meg siteId vagy zoneId paramétert.' });
    }

    const equipmentFilter = { tenantId };
    if (siteId) equipmentFilter.Site = siteId;
    if (zoneId) equipmentFilter.Zone = zoneId;

    const equipments = await Dataplate.find(equipmentFilter).lean();
    if (!equipments || equipments.length === 0) {
      return res.status(404).json({ message: 'Nem található eszköz a megadott szűrővel.' });
    }

    const siteCache = new Map();
    const zoneCache = new Map();
    const certificateCache = new Map();
    const failures = [];
    const punchlistImages = [];

    let headerSite = siteId ? await getSiteCached(siteId, siteCache) : null;
    let headerZone = zoneId ? await getZoneCached(zoneId, zoneCache) : null;

    for (const equipment of equipments) {
      let inspection = null;

      if (equipment.lastInspectionId) {
        inspection = await Inspection.findOne({ _id: equipment.lastInspectionId, tenantId })
          .populate('inspectorId', 'firstName lastName email')
          .lean();
      }

      if (!inspection) {
        inspection = await Inspection.findOne({ equipmentId: equipment._id, tenantId })
          .sort({ inspectionDate: -1, createdAt: -1 })
          .populate('inspectorId', 'firstName lastName email')
          .lean();
      }

      if (!inspection) {
        continue;
      }

      const context = await resolveInspectionContext(inspection, {
        equipment,
        siteCache,
        zoneCache,
        certificateCache
      });

      if (context.error) continue;

      if (!headerSite && context.site) headerSite = context.site;
      if (!headerZone && zoneId && context.zone) headerZone = context.zone;

      const attachmentLookup = includeImages
        ? buildInspectionAttachmentLookup(
            inspection,
            context.equipment?.EqID || inspection.eqId
          )
        : null;
      if (includeImages && attachmentLookup?.all?.length) {
        punchlistImages.push(...attachmentLookup.all);
      }

      const failedResults = Array.isArray(inspection.results)
        ? inspection.results.filter(r => r.status === 'Failed')
        : [];

      failedResults.forEach(r => {
        const ref = deriveQuestionReference(r);
        const checkText =
        r.questionText?.eng ||
          r.questionText?.hun ||
          r.questionText?.hu ||
          r.question ||
          '';

        const imageNames = attachmentLookup.getFileNamesForResult(r);

        failures.push({
          eqId: context.equipment?.EqID || equipment.EqID || inspection.eqId,
          ref,
          check: checkText,
          note: r.note || '',
          imageNames: includeImages ? imageNames : []
        });
      });
    }

    if (failures.length === 0) {
      return res.status(404).json({ message: 'Nem találtunk hibás kérdést a megadott szűrővel.' });
    }

    const scopeLabel = zoneId
      ? 'All equipment in zone'
      : (siteId ? 'All equipment in project' : 'All equipment');

    const { workbook, fileName } = buildPunchlistWorkbook({
      site: headerSite,
      zone: headerZone,
      failures,
      reportDate: new Date(),
      scopeLabel
    });

    if (!includeImages) {
      res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const zipName = fileName.replace(/\.xlsx$/i, '') + '.zip';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('Error exporting punchlist ZIP:', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    archive.pipe(res);
    archive.append(workbookBuffer, { name: fileName });
    await appendImagesToArchive(archive, punchlistImages);
    await archive.finalize();
  } catch (err) {
    console.error('Error exporting punchlist XLSX:', err);
    return res.status(500).json({ message: 'Failed to export punchlist report', error: err.message });
  }
};

exports.exportLatestInspectionReportsZip = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { zoneId, siteId } = req.query || {};
    const includeImages = (req.query?.includeImages ?? 'true') !== 'false';

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!zoneId && !siteId) {
      return res.status(400).json({ message: 'Kérjük adjon meg zoneId vagy siteId paramétert.' });
    }

    const equipmentFilter = { tenantId };
    if (zoneId) equipmentFilter.Zone = zoneId;
    if (siteId) equipmentFilter.Site = siteId;

    const equipments = await Dataplate.find(equipmentFilter).lean();

    if (!equipments || equipments.length === 0) {
      return res.status(404).json({ message: 'Nem található eszköz a megadott szűrővel.' });
    }

    const siteCache = new Map();
    const zoneCache = new Map();
    const certificateCache = new Map();
    const files = [];
    const allImages = [];

    for (const equipment of equipments) {
      let inspection = null;

      if (equipment.lastInspectionId) {
        inspection = await Inspection.findOne({ _id: equipment.lastInspectionId, tenantId })
          .populate('inspectorId', 'firstName lastName email')
          .lean();
      }

      if (!inspection) {
        inspection = await Inspection.findOne({ equipmentId: equipment._id, tenantId })
          .sort({ inspectionDate: -1, createdAt: -1 })
          .populate('inspectorId', 'firstName lastName email')
          .lean();
      }

      if (!inspection) {
        continue;
      }

      const context = await resolveInspectionContext(inspection, {
        equipment,
        siteCache,
        zoneCache,
        certificateCache
      });

      if (context.error) continue;

      const attachmentLookup = includeImages
        ? buildInspectionAttachmentLookup(
            inspection,
            context.equipment?.EqID || inspection.eqId
          )
        : null;

      const { workbook, fileName } = buildInspectionWorkbook(
        inspection,
        context.equipment,
        context.site,
        context.zone,
        context.scheme,
        attachmentLookup
      );
      const buffer = await workbook.xlsx.writeBuffer();
      files.push({ buffer, fileName });
      if (includeImages && attachmentLookup?.all?.length) {
        allImages.push(...attachmentLookup.all);
      }
    }

    if (files.length === 0) {
      return res.status(404).json({ message: 'Nem találtunk inspectiont a megadott zónában/projektben.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="inspection-reports.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('Error while creating inspection ZIP:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Hiba a ZIP készítésekor.' });
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    files.forEach(({ buffer, fileName }) => {
      archive.append(buffer, { name: fileName });
    });
    if (includeImages) {
      await appendImagesToArchive(archive, allImages);
    }
    await archive.finalize();
  } catch (err) {
    console.error('Error exporting inspection ZIP:', err);
    return res.status(500).json({ message: 'Failed to export inspection reports ZIP', error: err.message });
  }
};
