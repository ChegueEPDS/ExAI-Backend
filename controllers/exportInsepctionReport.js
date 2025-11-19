// controllers/exportInsepctionReport.js

const ExcelJS = require('exceljs');
const Inspection = require('../models/inspection');
const Dataplate = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const Certificate = require('../models/certificate');

exports.exportInspectionXLSX = async (req, res) => {
  try {
    const { id } = req.params;

    const inspection = await Inspection.findById(id)
      .populate('inspectorId', 'firstName lastName email')
      .lean();

    if (!inspection) {
      return res.status(404).json({ message: 'Inspection not found' });
    }

    // Equipment (Dataplate / ExReg)
    // Some inspections may store the EqID string, others the Dataplate _id – try both.
    let equipment = null;

    if (inspection.equipmentId) {
      // 1) Try matching by EqID (most common case)
      equipment = await Dataplate.findOne({ EqID: inspection.equipmentId }).lean();

      // 2) If not found, try interpreting equipmentId as a Dataplate _id
      if (!equipment) {
        try {
          equipment = await Dataplate.findById(inspection.equipmentId).lean();
        } catch (e) {
          // Ignore cast errors, we'll handle "not found" below
        }
      }
    }

    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    // Site + Zone
    const site = equipment.Site ? await Site.findById(equipment.Site).lean() : null;
    const zone = equipment.Zone ? await Zone.findById(equipment.Zone).lean() : null;

    // Certificate (first hit) – scheme meghatározása
    let scheme = '';
    const equipmentCertNo = equipment['Certificate No'];

    if (equipmentCertNo) {
      // 1) Próbáljuk megkeresni a Certificate kollekcióban certNo alapján
      let cert = await Certificate.findOne({ certNo: equipmentCertNo })
        .collation({ locale: 'en', strength: 2 }) // case-insensitive összehasonlítás
        .lean();

      // Ha találtunk certet, akkor onnan vesszük a scheme-et
      if (cert && cert.scheme) {
        scheme = cert.scheme;
      } else {
        // 2) Ha nincs cert a DB-ben, akkor a tanúsítványszám szövegéből próbáljuk kitalálni
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
    }

    // -------- Excel workbook + sheet --------
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Inspection Report');

    // Oszlopszélességek – kb. a tervhez igazítva
    ws.columns = [
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

    const titleFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'ffffcc00' }
    };

    const headerFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7E7E7' }
    };

    const borderThin = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };

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
    titleCell.fill = titleFill;

    ws.mergeCells('L1:L2');
    ws.getCell('L1').value = 'Date:';
    ws.getCell('L1').font = { bold: true, size: 16 };
    ws.getCell('L1').alignment = { horizontal: 'right', vertical: 'middle' };
    ws.getCell('L1').fill= headerFill;

    ws.mergeCells('M1:N2');
    ws.getCell('M1').value = inspectionDate;
    ws.getCell('M1').font = { size: 16 };
    ws.getCell('M1').numFmt = 'yyyy-mm-dd';
    ws.getCell('M1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('M1').fill= headerFill;

    // üres sor (3)
    const emptyRow3 = ws.addRow([]);
    emptyRow3.height = 7;

    // ========= 3. sor – Client / Project / Zone =========
    ws.mergeCells('A4:B4');
    ws.getCell('A4').value = 'Client name';
    ws.getCell('A4').font = { bold: true };
    ws.getCell('A4').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('A4').fill= headerFill;

    ws.mergeCells('C4:E4');
    ws.getCell('C4').value = site?.Client || '';
    ws.getCell('C4').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('F4:G4');
    ws.getCell('F4').value = 'Project';
    ws.getCell('F4').font = { bold: true };
    ws.getCell('F4').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('F4').fill= headerFill;

    ws.mergeCells('H4:J4');
    ws.getCell('H4').value = site?.Name || '';
    ws.getCell('H4').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('K4:L4');
    ws.getCell('K4').value = 'Zone';
    ws.getCell('K4').font = { bold: true };
    ws.getCell('K4').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('K4').fill= headerFill;

    ws.mergeCells('M4:N4');
    ws.getCell('M4').value = zone?.Name || zone?.ZoneName || '';
    ws.getCell('M4').alignment = { horizontal: 'center', vertical: 'middle' };

    // ========= 5. sor – Equipment ID / Manufacturer / Model =========
    ws.mergeCells('A5:B5');
    ws.getCell('A5').value = 'Equipment ID';
    ws.getCell('A5').font = { bold: true };
    ws.getCell('A5').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('A5').fill= headerFill;

    ws.mergeCells('C5:E5');
    ws.getCell('C5').value = equipment.EqID || '';
    ws.getCell('C5').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('F5:G5');
    ws.getCell('F5').value = 'Manufacturer';
    ws.getCell('F5').font = { bold: true };
    ws.getCell('F5').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('F5').fill= headerFill;

    ws.mergeCells('H5:J5');
    ws.getCell('H5').value = equipment.Manufacturer || '';
    ws.getCell('H5').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('K5:L5');
    ws.getCell('K5').value = 'Model';
    ws.getCell('K5').font = { bold: true };
    ws.getCell('K5').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('K5').fill= headerFill;

    ws.mergeCells('M5:N5');
    ws.getCell('M5').value = equipment['Model/Type'] || '';
    ws.getCell('M5').alignment = { horizontal: 'center', vertical: 'middle' };

    // ========= 6. sor – Certificate / Ex scheme =========
    ws.mergeCells('A6:B6');
    ws.getCell('A6').value = 'Certificate no';
    ws.getCell('A6').font = { bold: true };
    ws.getCell('A6').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('A6').fill= headerFill;

    ws.mergeCells('C6:E6');
    ws.getCell('C6').value = equipment['Certificate No'] || '';
    ws.getCell('C6').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('F6:G6');
    ws.getCell('F6').value = 'Ex scheme';
    ws.getCell('F6').font = { bold: true };
    ws.getCell('F6').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('F6').fill= headerFill;

    ws.mergeCells('H6:N6');
    ws.getCell('H6').value = scheme || '';
    ws.getCell('H6').alignment = { horizontal: 'center', vertical: 'middle' };

    // üres sor (7)
    const emptyRow7 = ws.addRow([]);
    emptyRow7.height = 7;

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
    ws.getCell('C8').fill = headerFill
    ws.getCell('D8').value = zoneNumber || '';

    ws.getCell('E8').value = 'Group';
    ws.getCell('E8').font = { bold: true };
    ws.getCell('E8').fill = headerFill;
    ws.getCell('F8').value = zoneSubGroup || '';

    ws.getCell('G8').value = 'Temp Class';
    ws.getCell('G8').font = { bold: true };
    ws.getCell('G8').fill = headerFill;
    ws.getCell('H8').value = zoneTempDisplay || '';

    ws.getCell('I8').value = 'Tamb';
    ws.getCell('I8').font = { bold: true };
    ws.getCell('I8').fill = headerFill;
    ws.getCell('J8').value = '';        // Area Tamb – user tölti

    ws.getCell('K8').value = 'IP Rating';
    ws.getCell('K8').font = { bold: true };
    ws.getCell('K8').fill = headerFill;
    ws.getCell('L8').value = '';        // Area IP – user tölti

    ws.getCell('M8').value = 'EPL';
    ws.getCell('M8').font = { bold: true };
    ws.getCell('M8').fill = headerFill;
    ws.getCell('N8').value = '';        // Area EPL – user tölti

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
    ws.getCell('C9').fill = headerFill;
    ws.getCell('D9').value = exMarking['Type of Protection'] || '';

    ws.getCell('E9').value = 'Group';
    ws.getCell('E9').font = { bold: true };
    ws.getCell('E9').fill = headerFill;
    ws.getCell('F9').value = exMarking['Gas / Dust Group'] || '';

    ws.getCell('G9').value = 'Temp Rating';
    ws.getCell('G9').font = { bold: true };
    ws.getCell('G9').fill = headerFill;
    ws.getCell('H9').value = exMarking['Temperature Class'] || '';

    ws.getCell('I9').value = 'Tamb';
    ws.getCell('I9').font = { bold: true };
    ws.getCell('I9').fill = headerFill;
    ws.getCell('J9').value = equipment['Max Ambient Temp'] || '';

    ws.getCell('K9').value = 'IP Rating';
    ws.getCell('K9').font = { bold: true };
    ws.getCell('K9').fill = headerFill;
    ws.getCell('L9').value = equipment['IP rating'] || '';

    ws.getCell('M9').value = 'EPL';
    ws.getCell('M9').font = { bold: true };
    ws.getCell('M9').fill = headerFill;
    ws.getCell('N9').value = exMarking['Equipment Protection Level'] || '';

    // Keret + igazítás a 8–9. sorra (A–N oszlop)
    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      [4, 5, 6, 8, 9].forEach(rn => {
        const cell = ws.getCell(`${col}${rn}`);
        cell.border = borderThin;
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
        cell.border = borderThin;
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
        cell.fill = headerFill;
        cell.border = borderThin;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      });

      // Kérdések
      grouped[groupName].forEach(r => {
        const ref =
          r.reference ||
          (r.table && r.group && r.number
            ? `${r.table}-${r.group}-${r.number}`
            : '');

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
          cell.border = borderThin;
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
    createdByCell.border = borderThin;

    // Right block: Signature
    ws.mergeCells(`H${fr}:N${fr}`);
    const signatureCell = ws.getCell(`H${fr}`);
    signatureCell.value = 'Signature: ____________________________';
    signatureCell.font = { bold: true, size: 16 }; //color: { argb: 'dedede' },
    signatureCell.alignment = { horizontal: 'center', vertical: 'middle' };
    signatureCell.border = borderThin;

    // Végső finomhangolás: magasság a felső sorokra
    [1,2,4,5,6,8,9].forEach(rn => {
      const row = ws.getRow(rn);
      row.height = 30;
    });

    // ========= STREAM KLIENS FELÉ =========
    const fileName = `Inspection_EQ_${equipment.EqID || 'unknown'}_${Date.now()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting inspection XLSX:', err);
    return res.status(500).json({ message: 'Failed to export inspection report', error: err.message });
  }
};