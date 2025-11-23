// controllers/exportInsepctionReport.js

const ExcelJS = require('exceljs');
const archiver = require('archiver');
const Inspection = require('../models/inspection');
const Dataplate = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const Certificate = require('../models/certificate');

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

function buildInspectionWorkbook(inspection, equipment, site, zone, scheme) {
  // -------- Excel workbook + sheet --------
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Inspection Report');

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

  // ========= 3. sor – Client / Project / Zone =========
  ws.mergeCells('A4:B4');
  ws.getCell('A4').value = 'Client name';
  ws.getCell('A4').font = { bold: true };
  ws.getCell('A4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('A4').fill= HEADER_FILL;

  ws.mergeCells('C4:E4');
  ws.getCell('C4').value = site?.Client || '';
  ws.getCell('C4').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('F4:G4');
  ws.getCell('F4').value = 'Project';
  ws.getCell('F4').font = { bold: true };
  ws.getCell('F4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('F4').fill= HEADER_FILL;

  ws.mergeCells('H4:J4');
  ws.getCell('H4').value = site?.Name || '';
  ws.getCell('H4').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('K4:L4');
  ws.getCell('K4').value = 'Zone';
  ws.getCell('K4').font = { bold: true };
  ws.getCell('K4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('K4').fill= HEADER_FILL;

  ws.mergeCells('M4:N4');
  ws.getCell('M4').value = zone?.Name || zone?.ZoneName || '';
  ws.getCell('M4').alignment = { horizontal: 'center', vertical: 'middle' };

  // ========= 5. sor – Equipment ID / Manufacturer / Model =========
  ws.mergeCells('A5:B5');
  ws.getCell('A5').value = 'Equipment ID';
  ws.getCell('A5').font = { bold: true };
  ws.getCell('A5').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('A5').fill= HEADER_FILL;

  ws.mergeCells('C5:E5');
  ws.getCell('C5').value = equipment.EqID || '';
  ws.getCell('C5').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('F5:G5');
  ws.getCell('F5').value = 'Manufacturer';
  ws.getCell('F5').font = { bold: true };
  ws.getCell('F5').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('F5').fill= HEADER_FILL;

  ws.mergeCells('H5:J5');
  ws.getCell('H5').value = equipment.Manufacturer || '';
  ws.getCell('H5').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('K5:L5');
  ws.getCell('K5').value = 'Model';
  ws.getCell('K5').font = { bold: true };
  ws.getCell('K5').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('K5').fill= HEADER_FILL;

  ws.mergeCells('M5:N5');
  ws.getCell('M5').value = equipment['Model/Type'] || '';
  ws.getCell('M5').alignment = { horizontal: 'center', vertical: 'middle' };

  // ========= 6. sor – Certificate / Ex scheme =========
  ws.mergeCells('A6:B6');
  ws.getCell('A6').value = 'Certificate no';
  ws.getCell('A6').font = { bold: true };
  ws.getCell('A6').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('A6').fill= HEADER_FILL;

  ws.mergeCells('C6:E6');
  ws.getCell('C6').value = equipment['Certificate No'] || '';
  ws.getCell('C6').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('F6:G6');
  ws.getCell('F6').value = 'Ex scheme';
  ws.getCell('F6').font = { bold: true };
  ws.getCell('F6').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('F6').fill= HEADER_FILL;

  ws.mergeCells('H6:J6');
  ws.getCell('H6').value = scheme || '';
  ws.getCell('H6').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells('K6:L6');
  ws.getCell('K6').value = 'Status'
  ws.getCell('K6').font = { bold: true };
  ws.getCell('K6').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('K6').fill= HEADER_FILL;

  const statusValue = inspection.status || '';
  const isPassed = statusValue === 'Passed';
  const isFailed = statusValue === 'Failed';
  
  ws.mergeCells('M6:N6');
  ws.getCell('M6').value = statusValue
  ws.getCell('M6').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell(`M6`).font = { bold: true };

  const statusCell = ws.getCell(`M6`);
  statusCell.value = statusValue;
  statusCell.font = {
    bold: true,
    color: isPassed
      ? { argb: 'FF008000' }  // green
      : isFailed
        ? { argb: 'FFFF0000' } // red
        : undefined
  };

  // üres sor (4)
  const emptyRow4 = ws.addRow([]);
  emptyRow4.height = 7;



  // ========= 8–9. sor – Area vs Equipment (új layout) =========

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

  // ----- 8. sor – Area -----
  ws.getCell('A8').value = 'Area';
  ws.mergeCells('A8:B8');
  ws.getCell('A8').font = { bold: true };
  ws.getCell('A8').fill = areaLabelFill;

  ws.getCell('C8').value = 'Zone';
  ws.getCell('C8').font = { bold: true };
  ws.getCell('C8').fill = HEADER_FILL
  ws.getCell('D8').value = zoneNumber || '';

  ws.getCell('E8').value = 'Group';
  ws.getCell('E8').font = { bold: true };
  ws.getCell('E8').fill = HEADER_FILL;
  ws.getCell('F8').value = zoneSubGroup || '';

  ws.getCell('G8').value = 'Temp Class';
  ws.getCell('G8').font = { bold: true };
  ws.getCell('G8').fill = HEADER_FILL;
  ws.getCell('H8').value = zoneTempDisplay || '';

  ws.getCell('I8').value = 'Tamb';
  ws.getCell('I8').font = { bold: true };
  ws.getCell('I8').fill = HEADER_FILL;
  ws.getCell('J8').value = ambientDisplay || '';

  ws.getCell('K8').value = 'IP Rating';
  ws.getCell('K8').font = { bold: true };
  ws.getCell('K8').fill = HEADER_FILL;
  ws.getCell('L8').value = zoneIpRating;

  ws.getCell('M8').value = 'EPL';
  ws.getCell('M8').font = { bold: true };
  ws.getCell('M8').fill = HEADER_FILL;
  ws.getCell('N8').value = zoneEpl;

  // ----- 9. sor – Equipment -----
  const exMarking = Array.isArray(equipment['Ex Marking'])
    ? equipment['Ex Marking'][0] || {}
    : {};

  ws.getCell('A9').value = 'Equipment';
  ws.mergeCells('A9:B9');
  ws.getCell('A9').font = { bold: true };
  ws.getCell('A9').fill = equipmentLabelFill;

  ws.getCell('C9').value = 'Ex Type';
  ws.getCell('C9').font = { bold: true };
  ws.getCell('C9').fill = HEADER_FILL;
  ws.getCell('D9').value = exMarking['Type of Protection'] || '';

  ws.getCell('E9').value = 'Group';
  ws.getCell('E9').font = { bold: true };
  ws.getCell('E9').fill = HEADER_FILL;
  ws.getCell('F9').value = exMarking['Gas / Dust Group'] || '';

  ws.getCell('G9').value = 'Temp Rating';
  ws.getCell('G9').font = { bold: true };
  ws.getCell('G9').fill = HEADER_FILL;
  ws.getCell('H9').value = exMarking['Temperature Class'] || '';

  ws.getCell('I9').value = 'Tamb';
  ws.getCell('I9').font = { bold: true };
  ws.getCell('I9').fill = HEADER_FILL;
  ws.getCell('J9').value = equipment['Max Ambient Temp'] || '';

  ws.getCell('K9').value = 'IP Rating';
  ws.getCell('K9').font = { bold: true };
  ws.getCell('K9').fill = HEADER_FILL;
  ws.getCell('L9').value = equipment['IP rating'] || '';

  ws.getCell('M9').value = 'EPL';
  ws.getCell('M9').font = { bold: true };
  ws.getCell('M9').fill = HEADER_FILL;
  ws.getCell('N9').value = exMarking['Equipment Protection Level'] || '';

  // Keret + igazítás a 8–9. sorra (A–N oszlop)
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
    [4, 5, 6, 8, 9].forEach(rn => {
      const cell = ws.getCell(`${col}${rn}`);
      cell.border = BORDER_THIN;
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true
      };
    });
  });

  // Üres sor a blokk után
  const emptyRowAfterBlock = ws.addRow([]);
  emptyRowAfterBlock.height = 7;

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
      let ref =
        r.reference ||
        (r.table && r.group && r.number
          ? `${r.table}-${r.group}-${r.number}`
          : '');

      // Special Condition kérdések: Ref = SC1, SC2, ...
      const tableVal = r.table || r.Table;
      if (tableVal === 'SC' || r.equipmentType === 'Special Condition') {
        const num =
          typeof r.number === 'number'
            ? r.number
            : (typeof r.Number === 'number' ? r.Number : 1);
        ref = `SC${num}`;
      }

      const status = r.status || r.result || ''; // Passed / Failed / NA

      const passedMark = status === 'Passed' ? 'X' : '';
      const failedMark = status === 'Failed' ? 'X' : '';
      const naMark = status === 'NA' ? 'X' : '';

      const questionText =
        (r.questionText && (r.questionText.hu || r.questionText.eng)) ||
        r.question ||
        '';

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
        r.note || ''
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
      const textLength = (questionText && questionText.length) ? questionText.length : 1;
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
  [1,2,4,5,6,8,9].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = 30;
  });

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
  headerValues[13] = 'Priority'; // M

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
    rowValues[13] = item.priority || ''; // M (merged M-N)

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
    const textLength = Math.max(checkText.length, noteText.length, 1);
    const lineCount = Math.max(1, Math.ceil(textLength / 60));
    ws.getRow(rn).height = lineCount * 15;
  });

  const fileName = `Punchlist_${site?.Name || zone?.Name || 'report'}_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

exports.exportInspectionXLSX = async (req, res) => {
  try {
    const { id } = req.params;

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

    const { workbook, fileName } = buildInspectionWorkbook(
      inspection,
      context.equipment,
      context.site,
      context.zone,
      context.scheme
    );

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting inspection XLSX:', err);
    return res.status(500).json({ message: 'Failed to export inspection report', error: err.message });
  }
};

exports.exportPunchlistXLSX = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { siteId, zoneId } = req.query || {};

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

      const failedResults = Array.isArray(inspection.results)
        ? inspection.results.filter(r => r.status === 'Failed')
        : [];

      failedResults.forEach(r => {
        let ref =
          r.reference ||
          (r.table && r.group && r.number
            ? `${r.table}-${r.group}-${r.number}`
            : '');

        const tableVal = r.table || r.Table;
        if (tableVal === 'SC' || r.equipmentType === 'Special Condition') {
          const num =
            typeof r.number === 'number'
              ? r.number
              : (typeof r.Number === 'number' ? r.Number : 1);
          ref = `SC${num}`;
        }

        const checkText =
          r.questionText?.hun ||
          r.questionText?.hu ||
          r.questionText?.eng ||
          r.question ||
          '';

        failures.push({
          eqId: context.equipment?.EqID || equipment.EqID || inspection.eqId,
          ref,
          check: checkText,
          note: r.note || '',
          priority: r.priority || r.Priority || ''
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

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting punchlist XLSX:', err);
    return res.status(500).json({ message: 'Failed to export punchlist report', error: err.message });
  }
};

exports.exportLatestInspectionReportsZip = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { zoneId, siteId } = req.query || {};

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

      const { workbook, fileName } = buildInspectionWorkbook(
        inspection,
        context.equipment,
        context.site,
        context.zone,
        context.scheme
      );
      const buffer = await workbook.xlsx.writeBuffer();
      files.push({ buffer, fileName });
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

    await archive.finalize();
  } catch (err) {
    console.error('Error exporting inspection ZIP:', err);
    return res.status(500).json({ message: 'Failed to export inspection reports ZIP', error: err.message });
  }
};
