// controllers/exRegisterController.js
const Equipment = require('../models/dataplate');
const Zone = require('../models/zone');
const Site = require('../models/site');
const Inspection = require('../models/inspection');
const Certificate = require('../models/certificate');
const Question = require('../models/questions');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const mongoose = require('mongoose');
const fs = require('fs');
const azureBlob = require('../services/azureBlobService');
const mime = require('mime-types');
const ExcelJS = require('exceljs');
const unzipper = require('unzipper');
const {
  buildCertificateCacheForTenant,
  resolveCertificateFromCache
} = require('../helpers/certificateMatchHelper');

const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');

const HEADER_ALIASES = {
  '#': '#',
  'tag no': 'TagNo',
  'tag#': 'TagNo',
  'tagno': 'TagNo',
  'eq id': 'EqID',
  'eqid': 'EqID',
  'description': 'Description',
  'manufacturer': 'Manufacturer',
  'model': 'Model',
  'model/type': 'Model',
  'serial number': 'Serial Number',
  'serial no': 'Serial Number',
  'serial#': 'Serial Number',
  'ip rating': 'IP rating',
  'temp range': 'Temp. Range',
  'temp. range': 'Temp. Range',
  'temperature range': 'Temp. Range',
  'epl': 'EPL',
  'subgroup': 'SubGroup',
  'sub group': 'SubGroup',
  'temperature class': 'Temperature Class',
  'protection concept': 'Protection Concept',
  'certificate no': 'Certificate No',
  'certificate number': 'Certificate No',
  'declaration of conformity': 'Declaration of conformity',
  'declaration of comformity': 'Declaration of conformity',
  'type': 'Type',
  'inspection type': 'Type',
  'inspectiontype': 'Type',
  'inspection date': 'Inspection Date',
  'inspection status': 'Status',
  'status': 'Status',
  'remarks': 'Remarks',
  'comments': 'Remarks',
  'comment': 'Remarks'
};

const SEARCHABLE_EQUIPMENT_FIELDS = [
  'TagNo',
  'EqID',
  'Manufacturer',
  'Model/Type',
  'Serial Number',
  'Equipment Type',
  'Description',
  'Certificate No',
  'Compliance',
  'Other Info'
];

const EXCEL_SERIAL_DATE_OFFSET = 25569;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GAS_SUBGROUPS = new Set(['IIA', 'IIB', 'IIC']);
const DUST_SUBGROUPS = new Set(['IIIA', 'IIIB', 'IIIC']);

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toObjectId(value) {
  if (!value) return null;
  try {
    return new mongoose.Types.ObjectId(value);
  } catch {
    return null;
  }
}

// Létrehozás (POST /exreg)
// 🔧 Segédfüggvény a fájlnév tisztítására
function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
}

function slug(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}
function buildTenantRoot(tenantName, tenantId) {
  const tn = slug(tenantName) || `TENANT_${tenantId}`;
  return `${tn}`;
}

// 🔢 Következő sorszám kiszámítása az adott zónán/projekten belül
async function getNextOrderIndex(tenantId, siteId, zoneId) {
  const filter = { tenantId };
  if (zoneId) filter.Zone = zoneId;
  if (siteId) filter.Site = siteId;

  const maxDoc = await Equipment.find(filter)
    .sort({ orderIndex: -1 })
    .limit(1)
    .select('orderIndex')
    .lean();

  const currentMax =
    Array.isArray(maxDoc) && maxDoc.length
      ? (typeof maxDoc[0].orderIndex === 'number' ? maxDoc[0].orderIndex : 0)
      : (maxDoc && typeof maxDoc.orderIndex === 'number' ? maxDoc.orderIndex : 0);

  return (currentMax || 0) + 1;
}

function normalizeImageTag(tag, fallback = 'general') {
  const allowed = ['dataplate', 'general', 'fault'];
  const value = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  return allowed.includes(value) ? value : fallback;
}
function buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, eqId) {
  const root = buildTenantRoot(tenantName, tenantId);
  if (siteName && zoneName) {
    return `${root}/projects/${slug(siteName)}/${slug(zoneName)}/${slug(eqId)}`;
  }
  return `${root}/equipment/${slug(eqId)}`;
}

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Move (copy+delete) all blobs under a prefix to a new prefix
async function moveAllUnderPrefix(oldPrefix, newPrefix) {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is missing');
  const containerName = process.env.AZURE_BLOB_CONTAINER_NAME || 'certificates';

  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(containerName);

  const srcPrefix = String(oldPrefix).replace(/^\/+/, '');
  const dstPrefix = String(newPrefix).replace(/^\/+/, '');

  for await (const item of container.listBlobsFlat({ prefix: srcPrefix })) {
    const fileName = item.name.slice(srcPrefix.length).replace(/^\/+/, '');
    const srcPath = item.name;
    const dstPath = `${dstPrefix}/${fileName}`;
    try {
      await azureBlob.renameFile(srcPath, dstPath);
    } catch (e) {
      try { console.warn('[exreg] moveAllUnderPrefix failed', { srcPath, dstPath, err: e?.message }); } catch {}
    }
  }
}

function normalizeHeaderLabel(value) {
  if (value == null) return '';
  let raw = value;
  if (typeof value === 'object') {
    if (value.text) {
      raw = value.text;
    } else if (Array.isArray(value.richText)) {
      raw = value.richText.map(part => part.text).join('');
    } else if (value.result != null) {
      raw = value.result;
    } else {
      raw = value.toString();
    }
  }
  const asString = String(raw || '').trim();
  if (!asString) return '';
  const alias = HEADER_ALIASES[asString.toLowerCase()];
  return alias || asString;
}

function buildHeaderMap(row) {
  const map = {};
  row?.eachCell?.({ includeEmpty: true }, (cell, columnNumber) => {
    const label = normalizeHeaderLabel(cell?.value);
    if (label && !map[label]) {
      map[label] = columnNumber;
    }
  });
  return map;
}

function detectHeaderRow(worksheet) {
  const limit = Math.min(worksheet?.rowCount || 0, 10);
  for (let i = 1; i <= limit; i += 1) {
    const row = worksheet.getRow(i);
    const headerMap = buildHeaderMap(row);
    if (headerMap['EqID'] || headerMap['TagNo'] || headerMap['Description']) {
      return { headerRowNumber: i, headerMap };
    }
  }
  return null;
}

function cellValueToPrimitive(cellValue) {
  if (cellValue == null) return null;
  if (cellValue instanceof Date) return cellValue;
  if (typeof cellValue === 'object') {
    if (cellValue.text) return cellValue.text;
    if (Array.isArray(cellValue.richText)) {
      return cellValue.richText.map(part => part.text).join('');
    }
    if (cellValue.result != null) return cellValue.result;
    if (typeof cellValue.hyperlink === 'string' && cellValue.text) {
      return cellValue.text;
    }
  }
  return cellValue;
}

function getCellString(row, headerMap, label) {
  const column = headerMap[label];
  if (!column) return '';
  const primitive = cellValueToPrimitive(row.getCell(column)?.value);
  if (primitive == null) return '';
  if (primitive instanceof Date) {
    return primitive.toISOString().split('T')[0];
  }
  return String(primitive).trim();
}

function normalizeExcelDateValue(value) {
  if (value == null && value !== 0) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.round((value - EXCEL_SERIAL_DATE_OFFSET) * MS_PER_DAY);
    return new Date(millis);
  }
  const text = String(value || '').trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getCellDate(row, headerMap, label) {
  const column = headerMap[label];
  if (!column) return null;
  const primitive = cellValueToPrimitive(row.getCell(column)?.value);
  return normalizeExcelDateValue(primitive);
}

function getCellStringByIndex(row, columnIndex) {
  const primitive = cellValueToPrimitive(row.getCell(columnIndex)?.value);
  if (primitive == null) return '';
  if (primitive instanceof Date) {
    return primitive.toISOString().split('T')[0];
  }
  return String(primitive).trim();
}

// 📄 XLSX sablon generálása a ZIP dokumentum-importhoz
// GET /exreg/documents-template
// Fejléc:
//   A: equipmentId (_id)
//   B: type (image|document)
//   C: tag/docType – image: dataplate|general|fault; document: DoC|IOM|Datasheet|Other...
//   D: filename (ahogy a ZIP-ben szerepel)
exports.downloadDocumentsTemplate = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Documents import');

    ws.columns = [
      { header: 'equipmentId', key: 'equipmentId', width: 28 },
      { header: 'type (image|document)', key: 'type', width: 20 },
      { header: 'tag / docType', key: 'tag', width: 32 },
      { header: 'filename in ZIP', key: 'filename', width: 40 }
    ];

    // Minta sorok: image + document
    ws.addRow({
      equipmentId: '650000000000000000000000',
      type: 'image',
      tag: 'dataplate',
      filename: 'photos/my_dataplate.jpg'
    });
    ws.addRow({
      equipmentId: '650000000000000000000000',
      type: 'document',
      tag: 'DoC',
      filename: 'docs/IECEx_certificate.pdf'
    });

    ws.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="equipment-documents-template.xlsx"'
    );
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('❌ downloadDocumentsTemplate error:', err);
    return res
      .status(500)
      .json({ message: 'Failed to generate documents template.', error: err.message || String(err) });
  }
};

function normalizeComplianceStatus(status) {
  if (!status) return 'NA';
  const lower = String(status).trim().toLowerCase();
  if (!lower) return 'NA';
  if (lower.startsWith('pass')) return 'Passed';
  if (lower.startsWith('fail')) return 'Failed';
  if (lower === 'na' || lower === 'n/a' || lower === 'n.a.') return 'NA';
  if (lower === 'passed') return 'Passed';
  if (lower === 'failed') return 'Failed';
  return 'NA';
}

function normalizeInspectionType(rawType) {
  if (!rawType) return 'Detailed';
  const value = String(rawType).trim().toLowerCase();
  if (!value) return 'Detailed';
  if (value.includes('visual')) return 'Visual';
  if (value.startsWith('close') || value.startsWith('closed')) return 'Close';
  if (value.startsWith('detailed')) return 'Detailed';
  return 'Detailed';
}

function determineEnvironmentFromSubGroup(value) {
  if (!value) return '';
  const entries = String(value)
    .split(/[,\s/]+/)
    .map(v => v.trim().toUpperCase())
    .filter(Boolean);

  let hasGas = false;
  let hasDust = false;

  for (const entry of entries) {
    if (GAS_SUBGROUPS.has(entry)) hasGas = true;
    if (DUST_SUBGROUPS.has(entry)) hasDust = true;
  }

  if (hasGas && hasDust) return 'GD';
  if (hasGas) return 'G';
  if (hasDust) return 'D';
  return '';
}

function buildMarkingString(protectionConcept, subGroup, tempClass) {
  const parts = ['Ex'];
  const trimmedProtection = protectionConcept ? String(protectionConcept).trim() : '';
  const trimmedSubGroup = subGroup ? String(subGroup).trim() : '';
  const trimmedTempClass = tempClass ? String(tempClass).trim() : '';

  if (trimmedProtection) parts.push(trimmedProtection);
  if (trimmedSubGroup) parts.push(trimmedSubGroup);
  if (trimmedTempClass) parts.push(trimmedTempClass);

  if (parts.length <= 1) return '';
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function extractProtectionTypesFromEquipment(equipmentDoc) {
  const protection = equipmentDoc?.['Ex Marking']?.[0]?.['Type of Protection'] || '';
  if (!protection) return [];

  return String(protection)
    .split(/[;,|/ ]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

async function loadAutoInspectionQuestions(equipmentDoc, tenantId, inspectionType = 'Detailed') {
  try {
    const protections = extractProtectionTypesFromEquipment(equipmentDoc);
    const filter = {};
    const tenantObjectId = toObjectId(tenantId);
    if (tenantObjectId) {
      filter.tenantId = tenantObjectId;
    }

    if (protections.length) {
      filter.protectionTypes = {
        $in: protections.map(token => new RegExp(`^${escapeRegex(token)}$`, 'i'))
      };
    }

    let questions = await Question.find(filter).lean();

    if ((!questions || !questions.length) && tenantObjectId) {
      const fallbackFilter = { ...filter };
      delete fallbackFilter.tenantId;
      questions = await Question.find(fallbackFilter).lean();
    }

    if (!Array.isArray(questions)) {
      return [];
    }

    return questions.filter(q => {
      const types = Array.isArray(q.inspectionTypes) ? q.inspectionTypes : [];
      return !types.length || types.includes(inspectionType);
    });
  } catch (err) {
    console.error('⚠️ Failed to load auto inspection questions:', err);
    return [];
  }
}

async function getRelevantEquipmentTypesForDevice(equipmentDoc, tenantId) {
  const rawType =
    (equipmentDoc && typeof equipmentDoc === 'object'
      ? equipmentDoc['Equipment Type'] || equipmentDoc.EquipmentType || ''
      : '') || '';

  const normalized = String(rawType).toLowerCase().trim();
  const result = new Set();

  if (!normalized) {
    return result;
  }

  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) {
    return result;
  }

  try {
    const mappings = await QuestionTypeMapping.find({
      tenantId: tenantObjectId,
      active: true
    })
      .select('equipmentPattern equipmentTypes')
      .lean();

    mappings.forEach((m) => {
      const pattern = String(m.equipmentPattern || '').toLowerCase().trim();
      if (!pattern) return;
      if (!normalized.includes(pattern)) return;

      (m.equipmentTypes || []).forEach((t) => {
        if (!t) return;
        result.add(String(t).toLowerCase());
      });
    });
  } catch (err) {
    console.warn(
      '⚠️ getRelevantEquipmentTypesForDevice failed:',
      err?.message || err
    );
  }

  return result;
}

async function findCertificateByCertNoForTenant(certNoRaw, tenantId) {
  if (!certNoRaw || !certNoRaw.trim()) return null;

  const parts = certNoRaw
    .split(/[/,]/)
    .map(part => part.trim())
    .filter(Boolean);

  if (!parts.length) return null;

  const regexConditions = parts.map(part => {
    const normalized = part.replace(/\s+/g, '').toLowerCase();
    const pattern = normalized
      .split('')
      .map(ch => escapeRegex(ch))
      .join('.*');
    return {
      certNo: {
        $regex: new RegExp(pattern, 'i')
      }
    };
  });

  const tenantObjectId = toObjectId(tenantId);
  const visibilityFilter = tenantObjectId
    ? {
        $or: [
          { visibility: 'public' },
          { tenantId: tenantObjectId }
        ]
      }
    : { visibility: 'public' };

  try {
    return await Certificate.findOne({
      ...visibilityFilter,
      $or: regexConditions
    })
      .select('specCondition certNo')
      .lean();
  } catch (err) {
    console.error('⚠️ Failed to resolve certificate for auto inspection:', err);
    return null;
  }
}

async function buildSpecialConditionResult(equipmentDoc, tenantId) {
  const equipmentSpecific =
    (equipmentDoc &&
      typeof equipmentDoc === 'object' &&
      equipmentDoc['X condition'] &&
      typeof equipmentDoc['X condition'].Specific === 'string'
      ? equipmentDoc['X condition'].Specific
      : ''
    ).trim();

  let text = equipmentSpecific;

  if (!text) {
    const certNo = equipmentDoc?.['Certificate No'] || equipmentDoc?.CertificateNo;
    if (certNo) {
      const certificate = await findCertificateByCertNoForTenant(certNo, tenantId);
      text = certificate?.specCondition?.trim() || '';
    }
  }

  if (!text) return null;

  return {
    questionId: undefined,
    table: 'SC',
    group: 'SC',
    number: 1,
    equipmentType: 'Special Condition',
    protectionTypes: [],
    status: 'Passed',
    note: '',
    questionText: {
      eng: text,
      hun: ''
    }
  };
}

function summarizeAutoInspectionResults(results) {
  const summary = { failedCount: 0, naCount: 0, passedCount: 0 };

  results.forEach(result => {
    if (result.status === 'Failed') summary.failedCount += 1;
    else if (result.status === 'NA') summary.naCount += 1;
    else summary.passedCount += 1;
  });

  return {
    summary,
    status: summary.failedCount > 0 ? 'Failed' : 'Passed'
  };
}

// 📥 Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  try {
    const CreatedBy = req.userId;
    const tenantId = req.scope?.tenantId;
    const tenantSlug = (req.scope?.tenantName || '').toLowerCase();
    const isIndexTenant = tenantSlug === 'index' || tenantSlug === 'ind-ex';
    if (!tenantId) {
      return res.status(400).json({ message: "tenantId is missing from auth" });
    }
    const tenantName = req.scope?.tenantName || '';
    const files = Array.isArray(req.files) ? req.files : [];

    console.log('📥 Új equipment létrehozási kérés érkezett.');
    console.log('🧾 Felhasználó:', CreatedBy);
    console.log('🏢 Tenant:', tenantId);
    console.log('📦 Fájlok száma:', files.length);
    console.log('📨 Kérelmi body (equipmentData):', req.body.equipmentData);
    console.log('📦 Beérkezett fájlok (req.files):');
      files.forEach((f, i) => {
        console.log(`  ${i + 1}. ${f.originalname} (${f.mimetype}, ${f.size} bytes)`);
      });

    let equipmentData = [];
    if (typeof req.body.equipmentData === 'string') {
      equipmentData = JSON.parse(req.body.equipmentData);
    } else if (Array.isArray(req.body.equipmentData)) {
      equipmentData = req.body.equipmentData;
    } else if (Array.isArray(req.body)) {
      equipmentData = req.body;
    }

    if (!equipmentData.length) {
      return res.status(400).json({ message: "No equipment data received." });
    }

    const results = [];

    for (const equipment of equipmentData) {
      if (!equipment["X condition"]) {
        equipment["X condition"] = { X: false, Specific: '' };
      }
      if (equipment["X condition"].Specific && equipment["X condition"].Specific.trim() !== '') {
        equipment["X condition"].X = true;
      }

      const _id = equipment._id || null;
      const rawEqId =
        typeof equipment.EqID === 'string'
          ? equipment.EqID.trim()
          : (equipment.EqID || '');

      // Blob elérési útvonalhoz kell egy azonosító, de az EqID mezőt nem töltjük ki automatikusan,
      // ha üresen jött (így a DB-ben az EqID üres maradhat).
      const eqIdForBlob = rawEqId || new mongoose.Types.ObjectId().toString();

      // ⚙️ EqID már NEM egyedi kulcs: csak _id alapján frissítünk
      let existingEquipment = null;
      if (_id) {
        existingEquipment = await Equipment.findOne({ _id, tenantId });
      }

      let zoneDoc = null;
      let siteDoc = null;
      if (equipment.Zone && equipment.Site) {
        zoneDoc = await Zone.findById(equipment.Zone).lean();
        siteDoc = await Site.findById(equipment.Site).lean();
      }
      const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
      const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, eqIdForBlob);

      const equipmentFiles = files.filter(file => {
        const eqIdInName = file.originalname.split('__')[0];
        return eqIdInName === eqId;
      });

      console.log('🔍 EqID a feldolgozáshoz:', eqId);
      console.log('🔍 Fájlok, amelyek eqId alapján illeszkedtek:');
      equipmentFiles.forEach((f, i) => {
        console.log(`  ✅ ${i + 1}. ${f.originalname}`);
      });

      const pictures = [];
      for (const file of equipmentFiles) {
        const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
        const blobPath = `${eqPrefix}/${cleanName}`;
        const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
        await azureBlob.uploadFile(file.path, blobPath, guessedType);
        pictures.push({
          name: cleanName,
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: file.size,
          uploadedAt: new Date(),
          tag: 'dataplate'
        });
        try { fs.unlinkSync(file.path); } catch {}
      }

      console.log('💾 Equipment mentésre készül:', {
        EqID: rawEqId,
        Site: equipment.Site,
        Zone: equipment.Zone,
        PictureCount: pictures.length,
        Pictures: pictures.map(p => p.name)
      });

      const updateFields = {
        ...equipment,
        EqID: eqId,
        tenantId,
        Pictures: [...(existingEquipment?.Pictures || []), ...pictures]
      };

      // Ha az UI nem ad meg orderIndex-et, automatikusan kiosztjuk a következő szabad sorszámot
      if (updateFields.orderIndex == null) {
        const siteIdForIndex = equipment.Site || null;
        const zoneIdForIndex = equipment.Zone || null;
        updateFields.orderIndex = await getNextOrderIndex(tenantId, siteIdForIndex, zoneIdForIndex);
      }

      if (existingEquipment) {
        updateFields.ModifiedBy = CreatedBy;
        const saved = await Equipment.findByIdAndUpdate(
          existingEquipment._id,
          { $set: updateFields },
          { new: true }
        );
        results.push(saved);
      } else {
        updateFields.CreatedBy = CreatedBy;
        const newEquipment = new Equipment(updateFields);
        const saved = await newEquipment.save();
        results.push(saved);
      }
    }

    return res.status(201).json(results);
  } catch (error) {
    console.error('❌ Hiba createEquipment-ben:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni vagy frissíteni az eszközt.' });
  }
};

exports.uploadImagesToEquipment = async (req, res) => {
  try {
    const equipmentId = req.params.id;
    const files = Array.isArray(req.files) ? req.files : [];

    const equipment = await Equipment.findById(equipmentId);
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId' });
    if (equipment?.tenantId && String(equipment.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: 'Forbidden (wrong tenant)' });
    }
    if (!equipment) return res.status(404).json({ message: "Equipment not found" });

    const tenantName = req.scope?.tenantName || '';
    let zoneDoc = null;
    let siteDoc = null;
    if (equipment.Zone && equipment.Site) {
      zoneDoc = await Zone.findById(equipment.Zone);
      siteDoc = await Site.findById(equipment.Site);
    }
    const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
    const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, equipment.EqID);

    console.log('📥 Képfeltöltési kérés érkezett:', {
      equipmentId: req.params.id,
      user: req.user?.email || req.userId,
      filesCount: Array.isArray(req.files) ? req.files.length : 0
    });

    const pictures = [];
    for (const file of files) {
      const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
      await azureBlob.uploadFile(file.path, blobPath, guessedType);
      pictures.push({
        name: cleanName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: file.size,
        uploadedAt: new Date(),
        tag: 'general'
      });
      try { fs.unlinkSync(file.path); } catch {}
    }

    equipment.Pictures = [...(equipment.Pictures || []), ...pictures];
    await equipment.save();
    return res.status(200).json({ message: "Images uploaded", pictures });
  } catch (error) {
    console.error('❌ uploadImagesToEquipment error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// 📎 Dokumentumok / képek feltöltése equipment szintre (POST /exreg/:id/upload-documents)
exports.uploadDocumentsToEquipment = async (req, res) => {
  try {
    const equipmentId = req.params.id;
    const files = Array.isArray(req.files) ? req.files : [];
    const aliasFromForm = req.body.alias;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    const tenantName = req.scope?.tenantName || '';

    let zoneDoc = null;
    let siteDoc = null;
    if (equipment.Zone && equipment.Site) {
      zoneDoc = await Zone.findById(equipment.Zone);
      siteDoc = await Site.findById(equipment.Site);
    }
    const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
    const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
    const eqPrefix = buildEquipmentPrefix(
      tenantName,
      tenantId,
      siteName,
      zoneName,
      equipment.EqID || equipment._id.toString()
    );

    if (!files.length) {
      return res.status(400).json({ message: 'No files provided' });
    }

    console.log('📥 Dokumentum feltöltés equipmenthez:', {
      equipmentId,
      tenantId,
      filesCount: files.length
    });

    const docs = [];
    const requestedTag = req.body?.tag;

    for (const file of files) {
      const cleanName = cleanFileName(file.originalname);
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';

      await azureBlob.uploadFile(file.path, blobPath, guessedType);

      const typeValue = String(guessedType).startsWith('image') ? 'image' : 'document';
      docs.push({
        name: cleanName,
        alias: aliasFromForm || cleanName,
        type: typeValue,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: file.size,
        uploadedAt: new Date(),
        tag: typeValue === 'image' ? normalizeImageTag(requestedTag, 'general') : null
      });

      try { fs.unlinkSync(file.path); } catch {}
    }

    equipment.documents = [...(equipment.documents || []), ...docs];
    await equipment.save();

    const savedDocs = equipment.documents.slice(-docs.length);

    return res.status(200).json({
      message: 'Documents uploaded',
      documents: savedDocs
    });
  } catch (error) {
    console.error('❌ uploadDocumentsToEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to upload documents for equipment.' });
  }
};

// 📄 Equipment dokumentumok listázása (GET /exreg/:id/documents)
exports.getDocumentsOfEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId }).lean();
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    return res.status(200).json(equipment.documents || []);
  } catch (error) {
    console.error('❌ getDocumentsOfEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch documents for equipment.' });
  }
};

// 🗑️ Equipment dokumentum törlése (DELETE /exreg/:id/documents/:docId)
exports.deleteDocumentFromEquipment = async (req, res) => {
  try {
    const { id, docId } = req.params;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    const docs = equipment.documents || [];
    const docToDelete = docs.find(doc =>
      doc._id?.toString() === docId || doc.blobPath === docId
    );

    if (!docToDelete) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const targetPath = docToDelete.blobPath;
    if (targetPath) {
      try {
        await azureBlob.deleteFile(targetPath);
      } catch (e) {
        console.warn('⚠️ Equipment document blob delete failed:', e?.message || e);
      }
    }

    equipment.documents = docs.filter(doc => doc._id.toString() !== docToDelete._id.toString());
    await equipment.save();

    return res.status(200).json({ message: 'Document deleted' });
  } catch (error) {
    console.error('❌ deleteDocumentFromEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to delete document from equipment.' });
  }
};

exports.importEquipmentXLSX = async (req, res) => {
  const tenantId = req.scope?.tenantId;
  const userId = req.userId;
  const uploadedFile = req.file;
  const zoneId = (req.body?.zoneId || req.query?.zoneId || '').trim();

  if (!tenantId) {
    return res.status(401).json({ message: 'Missing tenantId from auth.' });
  }
  if (!userId) {
    return res.status(401).json({ message: 'Missing user context.' });
  }
  if (!uploadedFile) {
    return res.status(400).json({ message: 'Missing XLSX file (field name: file).' });
  }
  if (!zoneId || !mongoose.Types.ObjectId.isValid(zoneId)) {
    return res.status(400).json({ message: 'Valid zoneId must be provided in the form data.' });
  }

  try {
    const tenantName = (req.scope?.tenantName || '').toLowerCase();
    const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';
    const zone = await Zone.findOne({ _id: zoneId, tenantId }).lean();
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found for this tenant.' });
    }
    let latestSkidId = zone?.SkidID || null;
    let latestSkidDescription = zone?.SkidDescription || null;
    let latestProjectId = zone?.ProjectID || null;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(uploadedFile.path);
    const worksheet = workbook.worksheets?.[0];
    if (!worksheet) {
      return res.status(400).json({ message: 'The uploaded workbook does not contain any worksheet.' });
    }

    const headerInfo = detectHeaderRow(worksheet);
    if (!headerInfo) {
      return res.status(400).json({ message: 'Unable to detect header row. Please use the provided export template.' });
    }

    const equipmentMap = new Map();
    const parseErrors = [];

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerInfo.headerRowNumber) return;

      const idRaw = getCellString(row, headerInfo.headerMap, '_id');
      const eqIdRaw = getCellString(row, headerInfo.headerMap, 'EqID');
      const eqId = eqIdRaw ? eqIdRaw.trim() : '';
      const mongoId = idRaw ? idRaw.trim() : '';
      const tagNo = getCellString(row, headerInfo.headerMap, 'TagNo');
      const description = getCellString(row, headerInfo.headerMap, 'Description');
      const manufacturer = getCellString(row, headerInfo.headerMap, 'Manufacturer');
      const model = getCellString(row, headerInfo.headerMap, 'Model');
      const serialNumber = getCellString(row, headerInfo.headerMap, 'Serial Number');
      const ipRating = getCellString(row, headerInfo.headerMap, 'IP rating');
      const tempRange = getCellString(row, headerInfo.headerMap, 'Temp. Range');
      const certificateNo = getCellString(row, headerInfo.headerMap, 'Certificate No');
      const declarationNo = getCellString(row, headerInfo.headerMap, 'Declaration of conformity');
      const remarks = getCellString(row, headerInfo.headerMap, 'Remarks');
      const epl = getCellString(row, headerInfo.headerMap, 'EPL');
      const subGroup = getCellString(row, headerInfo.headerMap, 'SubGroup');
      const tempClass = getCellString(row, headerInfo.headerMap, 'Temperature Class');
      const protectionConcept = getCellString(row, headerInfo.headerMap, 'Protection Concept');
      const indexRaw = getCellString(row, headerInfo.headerMap, '#');
      const parsedIndex = indexRaw ? parseInt(indexRaw, 10) : null;
      const orderIndex = Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : null;
      const inspectionStatus = normalizeComplianceStatus(getCellString(row, headerInfo.headerMap, 'Status'));
      const inspectionTypeRaw = getCellString(row, headerInfo.headerMap, 'Type');
      const inspectionType = inspectionTypeRaw ? normalizeInspectionType(inspectionTypeRaw) : null;
      const inspectionDate = getCellDate(row, headerInfo.headerMap, 'Inspection Date');
      let skidId = '';
      let skidDescription = '';
      let projectId = '';
      if (isIndexTenant) {
        skidId = getCellString(row, headerInfo.headerMap, 'Skid ID');
        skidDescription = getCellString(row, headerInfo.headerMap, 'Skid Description');
        projectId = getCellString(row, headerInfo.headerMap, 'Project ID');
        if (skidId) latestSkidId = skidId;
        if (skidDescription) latestSkidDescription = skidDescription;
        if (projectId) latestProjectId = projectId;
      }

      const rowHasData = [
        eqId,
        tagNo,
        description,
        manufacturer,
        model,
        serialNumber,
        ipRating,
        tempRange,
        certificateNo,
        declarationNo,
        remarks
      ].some(Boolean);

      const rowHasExData = [epl, subGroup, tempClass, protectionConcept].some(Boolean);

      if (!rowHasData && !rowHasExData) {
        // teljesen üres sor – kihagyjuk
        return;
      }

      // EqID nem egyedi: minden sor önálló "entry" (akkor is, ha EqID üres)
      const entryKey = `${eqId || 'NO_EQID'}__row_${rowNumber}`;
      if (!equipmentMap.has(entryKey)) {
        equipmentMap.set(entryKey, {
          rows: [],
          eqId,
          mongoId,
          orderIndex: orderIndex,
          base: {
            EqID: eqId,
            TagNo: tagNo || '',
            'Equipment Type': description || '',
            Manufacturer: manufacturer || '',
            'Model/Type': model || '',
            'Serial Number': serialNumber || '',
            'IP rating': ipRating || '',
            'Max Ambient Temp': tempRange || '',
            'Certificate No': certificateNo || declarationNo || '',
            'Other Info': remarks || '',
            Compliance: inspectionStatus || 'NA',
            'Ex Marking': [],
            'X condition': { X: false, Specific: '' }
          },
          inspectionDate: inspectionDate || null,
          inspectionStatus,
          inspectionType: inspectionType || null
        });
      }

      const entry = equipmentMap.get(entryKey);
      entry.rows.push(rowNumber);

       // Ha több soron keresztül jön ugyanahhoz az EqID-hez index, az első nem üres érték nyer
      if (orderIndex != null && entry.orderIndex == null) {
        entry.orderIndex = orderIndex;
      }

      if (tagNo && !entry.base.TagNo) entry.base.TagNo = tagNo;
      if (description) entry.base['Equipment Type'] = description;
      if (manufacturer) entry.base.Manufacturer = manufacturer;
      if (model) entry.base['Model/Type'] = model;
      if (serialNumber) entry.base['Serial Number'] = serialNumber;
      if (ipRating) entry.base['IP rating'] = ipRating;
      if (tempRange) entry.base['Max Ambient Temp'] = tempRange;
      if (certificateNo) entry.base['Certificate No'] = certificateNo;
      if (remarks) entry.base['Other Info'] = remarks;
      if (inspectionStatus && inspectionStatus !== 'NA') entry.base.Compliance = inspectionStatus;
      if (!entry.inspectionDate && inspectionDate) entry.inspectionDate = inspectionDate;
      if (entry.inspectionStatus === 'NA' && inspectionStatus !== 'NA') {
        entry.inspectionStatus = inspectionStatus;
      }
      if (inspectionType && (!entry.inspectionType || entry.inspectionType === 'Detailed')) {
        entry.inspectionType = inspectionType;
      }

      if (epl || subGroup || tempClass || protectionConcept) {
        const autoMarking = buildMarkingString(protectionConcept, subGroup, tempClass);
        const inferredEnvironment = determineEnvironmentFromSubGroup(subGroup);

        if (autoMarking && !entry.base.Marking) {
          entry.base.Marking = autoMarking;
        }

        const markingEntry = {
          'Equipment Protection Level': epl || '',
          'Gas / Dust Group': subGroup || '',
          'Temperature Class': tempClass || '',
          'Type of Protection': protectionConcept || ''
        };

        if (autoMarking) {
          markingEntry['Marking'] = autoMarking;
        }
        if (inferredEnvironment) {
          markingEntry['Environment'] = inferredEnvironment;
        }

        entry.base['Ex Marking'].push(markingEntry);
      }
    });

    const entries = Array.from(equipmentMap.values());
    if (!entries.length) {
      const baseMessage = 'No usable rows detected in the uploaded file.';
      if (parseErrors.length) {
        return res.status(400).json({ message: baseMessage, issues: parseErrors });
      }
      return res.status(400).json({ message: baseMessage });
    }

    const stats = { created: 0, updated: 0, inspections: 0, errors: [] };

    for (const entry of entries) {
      try {
        const payload = { ...entry.base };
        payload.Zone = zone._id;
        payload.Site = zone.Site || null;
        if (entry.orderIndex != null) {
          payload.orderIndex = entry.orderIndex;
        }
        payload['Ex Marking'] = (payload['Ex Marking'] || []).filter(mark =>
          Object.values(mark).some(value => !!String(value || '').trim())
        );

        let equipmentDoc = null;

        // 1) Első próbálkozás: explicit _id alapján frissítés (ha az exportból visszatöltötték)
        if (entry.mongoId && mongoose.Types.ObjectId.isValid(entry.mongoId)) {
          equipmentDoc = await Equipment.findOne({
            _id: entry.mongoId,
            tenantId,
            Zone: zone._id
          });
          if (equipmentDoc) {
            const updateData = { ...payload, ModifiedBy: userId };
            delete updateData.CreatedBy;
            delete updateData.tenantId;
            if (entry.orderIndex == null) {
              delete updateData.orderIndex;
            }
            equipmentDoc = await Equipment.findByIdAndUpdate(
              equipmentDoc._id,
              { $set: updateData },
              { new: true }
            );
            stats.updated += 1;
          }
        }

        // 2) Ha így sem találtunk, új eszközt hozunk létre
        if (!equipmentDoc) {
          const createData = {
            ...payload,
            tenantId,
            CreatedBy: userId
          };
          if (createData.orderIndex == null) {
            createData.orderIndex = await getNextOrderIndex(
              tenantId,
              createData.Site || null,
              createData.Zone || null
            );
          }
          equipmentDoc = await Equipment.create(createData);
          stats.created += 1;
        }

        if (
          equipmentDoc &&
          entry.inspectionStatus === 'Passed' &&
          entry.inspectionDate instanceof Date
        ) {
          try {
            await createAutoInspectionForImport(
              equipmentDoc,
              entry.inspectionDate,
              userId,
              tenantId,
              entry.inspectionType || 'Detailed'
            );
            stats.inspections += 1;
          } catch (inspectionError) {
            stats.errors.push({
              eqId: equipmentDoc.EqID,
              rows: entry.rows,
              message: `Auto inspection creation failed: ${inspectionError.message || inspectionError}`
            });
          }
        }
      } catch (entryError) {
        stats.errors.push({
          eqId: entry.eqId,
          id: entry.mongoId || null,
          rows: entry.rows,
          message: entryError.message || String(entryError)
        });
      }
    }

    if (isIndexTenant) {
      const zoneUpdate = {};
      if (latestSkidId && latestSkidId !== zone.SkidID) {
        zoneUpdate.SkidID = latestSkidId;
      }
      if (latestSkidDescription && latestSkidDescription !== zone.SkidDescription) {
        zoneUpdate.SkidDescription = latestSkidDescription;
      }
      if (latestProjectId && latestProjectId !== zone.ProjectID) {
        zoneUpdate.ProjectID = latestProjectId;
      }
      if (Object.keys(zoneUpdate).length) {
        await Zone.updateOne({ _id: zone._id }, { $set: zoneUpdate });
      }
    }

    const issues = [...parseErrors, ...stats.errors];

    // Ha volt bármilyen hiba, generáljunk egy válasz XLSX-et a hibás sorokkal
    if (issues.length > 0) {
      try {
        const workbookOut = new ExcelJS.Workbook();
        await workbookOut.xlsx.readFile(uploadedFile.path);
        const worksheet = workbookOut.worksheets[0];

        const summarySheet = workbookOut.addWorksheet('Import summary');
        summarySheet.addRow(['Created', stats.created]);
        summarySheet.addRow(['Updated', stats.updated]);
        summarySheet.addRow(['Inspections', stats.inspections]);
        summarySheet.addRow(['Error items', issues.length]);
        summarySheet.getColumn(1).width = 15;
        summarySheet.getColumn(2).width = 12;

        const errorFill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC0C0' } // halvány piros
        };

        issues.forEach((issue) => {
          const rows = Array.isArray(issue.rows)
            ? issue.rows
            : (typeof issue.row === 'number' ? [issue.row] : []);

          rows.forEach((rowNumber) => {
            if (!rowNumber || !worksheet) return;
            const row = worksheet.getRow(rowNumber);
            row.eachCell((cell) => {
              cell.fill = errorFill;
            });

            // Megjegyzés hozzáadása az első oszlophoz
            const noteCell = worksheet.getCell(`A${rowNumber}`);
            const existingNote =
              typeof noteCell.note === 'string' && noteCell.note.length
                ? `${noteCell.note}\n`
                : '';
            noteCell.note = `${existingNote}${issue.message || 'Invalid data in this row.'}`;
          });
        });

        const buffer = await workbookOut.xlsx.writeBuffer();
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=\"equipment-import-errors.xlsx\"'
        );
        return res.status(200).send(Buffer.from(buffer));
      } catch (excelErr) {
        console.warn(
          '⚠️ Failed to generate error XLSX for equipment import:',
          excelErr?.message || excelErr
        );
        // Ha az XLSX generálás is elhasal, essünk vissza JSON-re
        return res.status(200).json({
          message: 'Import completed with errors.',
          createdCount: stats.created,
          updatedCount: stats.updated,
          inspectionsCreated: stats.inspections,
          issues
        });
      }
    }

    // Ha nem volt hiba, marad a JSON válasz
    return res.json({
      message: 'Import completed.',
      createdCount: stats.created,
      updatedCount: stats.updated,
      inspectionsCreated: stats.inspections,
      issues: []
    });
  } catch (error) {
    console.error('❌ importEquipmentXLSX error:', error);
    return res.status(500).json({ message: 'Failed to import XLSX.', error: error.message || String(error) });
  } finally {
    if (uploadedFile?.path) {
      try { fs.unlinkSync(uploadedFile.path); } catch (cleanupErr) {
        console.warn('⚠️ Failed to remove uploaded XLSX file:', cleanupErr?.message || cleanupErr);
      }
    }
  }
};

// 📦 Dokumentumok / képek tömeges importja ZIP + XLSX alapján
// ZIP tartalma:
//  - egy XLSX fájl (neve egyezzen a ZIP nevével), első munkalap:
//      Col1: equipment _id
//      Col2: type  ("image" | "document")
//      Col3: tag / docType:
//            - image esetén: "dataplate" | "general" | "fault"
//            - document esetén: "DoC" | "IOM" | "Datasheet" | vagy tetszőleges saját szöveg
//      Col4: filename (ahogy a ZIP-ben szerepel)
//  - maga a fájl (kép / dokumentum) a ZIP-ben (akár almappában)
// TODO: background job + progress (mint az inspection exportnál), mert nagy ZIP-ek is jöhetnek
exports.importEquipmentDocumentsZip = async (req, res) => {
  const tenantId = req.scope?.tenantId;
  const userId = req.userId;
  const uploadedFile = req.file;
  const zoneIdRaw = (req.body?.zoneId || req.query?.zoneId || '').trim();
  let zoneObjectId = null;

  if (!tenantId) {
    return res.status(401).json({ message: 'Missing tenantId from auth.' });
  }
  if (!userId) {
    return res.status(401).json({ message: 'Missing user context.' });
  }
  if (!uploadedFile) {
    return res.status(400).json({ message: 'Missing ZIP file (field name: file).' });
  }

  try {
    const tenantObjectId = toObjectId(tenantId);
    if (!tenantObjectId) {
      return res.status(400).json({ message: 'Invalid tenantId.' });
    }
    if (zoneIdRaw) {
      if (!mongoose.Types.ObjectId.isValid(zoneIdRaw)) {
        return res.status(400).json({ message: 'Invalid zoneId.' });
      }
      zoneObjectId = new mongoose.Types.ObjectId(zoneIdRaw);
    }

    // 1) ZIP megnyitása
    const zipPath = uploadedFile.path;
    const directory = await unzipper.Open.file(zipPath);
    const allEntries = directory.files.filter(f => f.type === 'File');

    if (!allEntries.length) {
      return res.status(400).json({ message: 'ZIP archive is empty.' });
    }

    // 2) XLSX fájl keresése – a ZIP neve alapján:
    //    ha a ZIP neve pl. "zone123_docs.zip", akkor a mapping XLSX-nek
    //    "zone123_docs.xlsx"-nek kell lennie (bárhol a ZIP-ben).
    const zipBaseName = path.basename(uploadedFile.originalname || '', path.extname(uploadedFile.originalname || ''));
    let xlsxEntry = null;
    if (zipBaseName) {
      xlsxEntry =
        allEntries.find(e => {
          const base = path.basename(e.path, path.extname(e.path));
          return base.toLowerCase() === zipBaseName.toLowerCase();
        }) || null;
    }
    // Ha nem találtunk név alapján, ne essünk vissza "első xlsx"-re, mert
    // a ZIP-ben lehetnek normál dokumentumként is .xlsx fájlok.
    if (!xlsxEntry) {
      return res.status(400).json({
        message: `No XLSX mapping file found in ZIP that matches the ZIP name ("${zipBaseName}.xlsx").`
      });
    }

    const xlsxBuffer = await xlsxEntry.buffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsxBuffer);
    const worksheet = workbook.worksheets?.[0];
    if (!worksheet) {
      return res.status(400).json({ message: 'The XLSX mapping file has no worksheet.' });
    }

    // 3) ZIP entry map a fájlnevekhez (relatív útvonal + basename)
    //    Csak a MAPPING XLSX-et hagyjuk ki, minden más (beleértve a többi .xlsx-et is)
    //    dokumentumként használható.
    const entryByName = new Map();
    for (const entry of allEntries) {
      // mapping XLSX → már beolvastuk, NE kerüljön a dokumentumok közé
      if (entry === xlsxEntry) continue;

      const rel = entry.path.replace(/^[/\\]+/, '');
      entryByName.set(rel, entry);

      const base = path.posix.basename(rel);
      if (!entryByName.has(base)) {
        entryByName.set(base, entry);
      }
    }

    // 4) XLSX sorok feldolgozása és csoportosítás equipment szerint
    const docsByEquipment = new Map(); // key: equipmentId -> [{ type, imageTag, docAlias, fileName, entry }]
    const issues = [];

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // fejlécek

      const equipmentId = getCellStringByIndex(row, 1);
      const typeRaw = getCellStringByIndex(row, 2).toLowerCase();
      const tagCell = getCellStringByIndex(row, 3);           // eredeti formázással (DoC, IOM, ...)
      const tagRawLower = tagCell.toLowerCase();              // csak kép tagek normalizálásához
      const fileNameCell = getCellStringByIndex(row, 4);

      if (!equipmentId || !fileNameCell) {
        return;
      }

      const normalizedName = fileNameCell.replace(/^[/\\]+/, '');
      const entry =
        entryByName.get(normalizedName) ||
        entryByName.get(path.posix.basename(normalizedName));

      if (!entry) {
        issues.push(`Row ${rowNumber}: file "${fileNameCell}" not found in ZIP.`);
        return;
      }

      const type = typeRaw === 'image' ? 'image' : 'document';
      const imageTag = type === 'image'
        ? normalizeImageTag(tagRawLower || 'general', 'general')
        : null;
      // Dokumentum esetén a 3. oszlopot "docType"/alias-ként használjuk (DoC, IOM, Datasheet, stb.)
      const docAlias = type === 'document'
        ? (tagCell || '')
        : '';

      if (!docsByEquipment.has(equipmentId)) {
        docsByEquipment.set(equipmentId, []);
      }
      docsByEquipment.get(equipmentId).push({
        type,
        imageTag,
        docAlias,
        fileName: normalizedName,
        entry,
        rowNumber
      });
    });

    if (!docsByEquipment.size) {
      return res.status(400).json({ message: 'No valid rows found in XLSX mapping.' });
    }

    const tenantName = req.scope?.tenantName || '';
    const results = [];

    // 5) Fájlok feltöltése Azure Blobba és dokumentumok mentése equipmenthez
    for (const [equipmentId, items] of docsByEquipment.entries()) {
      const eqFilter = { _id: equipmentId, tenantId: tenantObjectId };
      if (zoneObjectId) {
        // Csak az adott zónához tartozó eszközöket engedjük importálni
        Object.assign(eqFilter, { Zone: zoneObjectId });
      }

      const equipment = await Equipment.findOne(eqFilter);
      if (!equipment) {
        issues.push(
          `Equipment ${equipmentId} not found for this tenant${
            zoneObjectId ? ' or does not belong to this zone' : ''
          }. Skipping its rows.`
        );
        continue;
      }

      let zoneDoc = null;
      let siteDoc = null;
      if (equipment.Zone && equipment.Site) {
        zoneDoc = await Zone.findById(equipment.Zone);
        siteDoc = await Site.findById(equipment.Site);
      }
      const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
      const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
      const eqPrefix = buildEquipmentPrefix(
        tenantName,
        tenantId,
        siteName,
        zoneName,
        equipment.EqID || equipment._id.toString()
      );

      const docs = [];
      for (const item of items) {
        try {
          const buf = await item.entry.buffer();
          const cleanName = cleanFileName(path.posix.basename(item.fileName));
          const aliasFromXlsx = (item.docAlias || '').trim();
          const blobPath = `${eqPrefix}/${cleanName}`;
          const guessedType =
            mime.lookup(cleanName) ||
            (item.type === 'image' ? 'image/jpeg' : 'application/octet-stream');

          await azureBlob.uploadBuffer(blobPath, buf, guessedType);

          docs.push({
            name: cleanName,
            // Dokumentumnál alias: XLSX 3. oszlop (DoC/IOM/Datasheet/egyéb), ha van;
            // különben esik vissza a fájlnévre.
            alias: item.type === 'document' && aliasFromXlsx
              ? aliasFromXlsx
              : cleanName,
            type: item.type,
            blobPath,
            blobUrl: azureBlob.getBlobUrl(blobPath),
            contentType: guessedType,
            size: buf.length,
            uploadedAt: new Date(),
            tag: item.type === 'image' ? item.imageTag : null
          });
        } catch (e) {
          issues.push(
            `Equipment ${equipmentId}, file "${item.fileName}": ${e?.message || 'upload failed'}`
          );
        }
      }

      if (docs.length) {
        equipment.documents = [...(equipment.documents || []), ...docs];
        await equipment.save();
        results.push({ equipmentId: equipment._id.toString(), added: docs.length });
      }
    }

    return res.status(200).json({
      message: 'Bulk equipment documents imported from ZIP.',
      updatedEquipments: results.length,
      details: results,
      issues
    });
  } catch (error) {
    console.error('❌ importEquipmentDocumentsZip error:', error);
    return res.status(500).json({
      message: 'Server error during ZIP import.',
      error: error.message || String(error)
    });
  } finally {
    if (uploadedFile?.path) {
      try { fs.unlinkSync(uploadedFile.path); } catch (cleanupErr) {
        console.warn('⚠️ Failed to remove uploaded ZIP file:', cleanupErr?.message || cleanupErr);
      }
    }
  }
};

async function createAutoInspectionForImport(equipmentDoc, inspectionDate, inspectorId, tenantId, inspectionType = 'Detailed') {
  const date = new Date(inspectionDate);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid inspection date provided.');
  }

  const validUntil = new Date(date);
  validUntil.setFullYear(validUntil.getFullYear() + 3);

  const normalizedInspectionType = normalizeInspectionType(inspectionType);
  const questionDocs = await loadAutoInspectionQuestions(
    equipmentDoc,
    tenantId,
    normalizedInspectionType
  );
  const basePassedTypes = new Set(['general', 'environment', 'additional checks']);
  const relevantTypes = await getRelevantEquipmentTypesForDevice(
    equipmentDoc,
    tenantId
  ); // lowercased equipmentType-ok
  let results = [];

  if (questionDocs.length) {
    results = questionDocs.map((q) => {
      const eqType = (q.equipmentType || '').toLowerCase();
      const isAlwaysPassed = basePassedTypes.has(eqType);
      const isRelevantByDevice = relevantTypes.has(eqType);

      return {
        questionId: q._id ? new mongoose.Types.ObjectId(q._id) : undefined,
        table: q.table || q.Table || '',
        group: q.group || q.Group || '',
        number: q.number ?? q.Number ?? null,
        equipmentType: q.equipmentType || '',
        protectionTypes: Array.isArray(q.protectionTypes)
          ? q.protectionTypes
          : [],
        status: isAlwaysPassed || isRelevantByDevice ? 'Passed' : 'NA',
        note: '',
        questionText: {
          eng: q.questionText?.eng || '',
          hun: q.questionText?.hun || ''
        }
      };
    });
  }

  if (!results.length) {
    results = [{
      status: 'NA',
      note: 'Automatically created during XLSX import (all checks passed).',
      table: 'AUTO',
      group: 'AUTO',
      number: 1,
      equipmentType: equipmentDoc['Equipment Type'] || equipmentDoc.EquipmentType || '',
      protectionTypes: [],
      questionText: {
        eng: 'Auto-generated inspection from XLSX import.',
        hun: 'Automatikus ellenőrzés XLSX importból.'
      }
    }];
  }

  const specialResult = await buildSpecialConditionResult(equipmentDoc, tenantId);
  if (specialResult) {
    results.push(specialResult);
  }

  const { summary, status } = summarizeAutoInspectionResults(results);

  const inspection = new Inspection({
    equipmentId: equipmentDoc._id,
    eqId: equipmentDoc.EqID,
    tenantId,
    siteId: equipmentDoc.Site || null,
    zoneId: equipmentDoc.Zone || null,
    inspectionDate: date,
    validUntil,
    inspectionType: normalizedInspectionType,
    inspectorId,
    results,
    attachments: [],
    summary,
    status
  });

  await inspection.save();

  equipmentDoc.Compliance = status;
  equipmentDoc.lastInspectionDate = date;
  equipmentDoc.lastInspectionValidUntil = validUntil;
  equipmentDoc.lastInspectionStatus = status;
  equipmentDoc.lastInspectionId = inspection._id;
  await equipmentDoc.save();

  return inspection;
}

// GET /exreg/export-xlsx
// Exportálja a kiválasztott / zónához / projekthez tartozó eszközöket Excel-be
exports.exportEquipmentXLSX = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const tenantSlug = (req.scope?.tenantName || '').toLowerCase();
    const isIndexTenant = tenantSlug === 'index' || tenantSlug === 'ind-ex';
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    const { ids, zoneId, siteId } = req.query || {};
    const filter = { tenantId };

    // 1) Kijelölt eszközök (ids paraméter)
    if (ids) {
      const rawIds = String(ids)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const objectIds = rawIds
        .map(id => {
          try {
            return new mongoose.Types.ObjectId(id);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (!objectIds.length) {
        return res.status(400).json({ message: 'Invalid ids parameter.' });
      }
      filter._id = { $in: objectIds };
    } else {
      // 2) Zóna / projekt alapú szűrés
      if (zoneId) filter.Zone = zoneId;
      if (siteId) filter.Site = siteId;
    }

    const equipments = await Equipment.find(filter)
      .sort({ orderIndex: 1, createdAt: 1, _id: 1 })
      .lean();

    if (!equipments || equipments.length === 0) {
      return res.status(404).json({ message: 'No equipment found for export.' });
    }

    // ---- Zóna cache ----
    const zoneIds = [
      ...new Set(
        equipments
          .map(e => (e.Zone ? e.Zone.toString() : null))
          .filter(Boolean)
      )
    ];
    const zones = zoneIds.length
      ? await Zone.find({ _id: { $in: zoneIds } }).lean()
      : [];
    const zoneMap = new Map(zones.map(z => [z._id.toString(), z]));

    // ---- Inspection cache (utolsó inspection az eszközhöz) ----
    const lastInspectionIds = [
      ...new Set(
        equipments
          .map(e => (e.lastInspectionId ? e.lastInspectionId.toString() : null))
          .filter(Boolean)
      )
    ];

    let inspections = [];
    if (lastInspectionIds.length) {
      inspections = await Inspection.find({
        _id: { $in: lastInspectionIds },
        tenantId
      })
        .populate('inspectorId', 'firstName lastName name')
        .lean();
    }
    const inspectionMap = new Map(
      inspections.map(i => [i._id.toString(), i])
    );

    let certMap = new Map();
    try {
      certMap = await buildCertificateCacheForTenant(tenantId);
    } catch (e) {
      console.warn('⚠️ Certificate cache build failed for exportEquipmentXLSX:', e?.message || e);
      certMap = new Map();
    }

    // ---- Excel workbook ----
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Database');

    const headers = [
      '_id',
      '#',
      'TagNo',
      'EqID',
      'Description',
      'Manufacturer',
      'Model',
      'Serial Number',
      'IP rating',
      'Temp. Range',
      'EPL',
      'SubGroup',
      'Temperature Class',
      'Protection Concept',
      //'Equipment Group',
      //'Equipment Category',
      //'Environment',
      'Certificate No',
      'Certificate Issue Date',
      'Special Condition',
      'Declaration of conformity',
      'Zone',
      'Gas / Dust Group',
      'Temp Rating',
      'Ambient Temp',
      'Req Zone',
      'Req Gas / Dust Group',
      'Req Temp Rating',
      'Req Ambient Temp',
      'Req IP Rating',
      'Inspection Date',
      'Inspector',
      'Type',
      'Status',
      'Remarks'
    ];

    if (isIndexTenant) {
      headers.splice(18, 0, 'Skid ID', 'Skid Description', 'Project ID');
    }

    worksheet.columns = headers.map(header => ({
      header,
      key: header,
      width: 2
    }));

    // ➕ Extra csoportosító sor a fejléc fölé
    // Beszúrunk egy üres sort az első helyre, így az eredeti fejléc a 2. sorba csúszik.
    worksheet.spliceRows(1, 0, []);

    const groupRow = worksheet.getRow(1);
    const zoneStartCol = isIndexTenant ? 22 : 19;
    const zoneEndCol = zoneStartCol + 3;
    const userStartCol = zoneStartCol + 4;
    const userEndCol = userStartCol + 4;
    const inspectionStartCol = userStartCol + 5;
    const inspectionEndCol = inspectionStartCol + 4;

    groupRow.getCell(1).value = 'IDENTIFICATION';
    worksheet.mergeCells(1, 1, 1, 4);
    groupRow.getCell(5).value = 'EQUIPMENT DATA';
    worksheet.mergeCells(1, 5, 1, 9);
    groupRow.getCell(10).value = 'EX DATA';
    worksheet.mergeCells(1, 10, 1, 14);
    groupRow.getCell(15).value = 'CERTIFICATION';
    worksheet.mergeCells(1, 15, 1, 18);
    if (isIndexTenant) {
      groupRow.getCell(19).value = 'PROJECT / SKID';
      worksheet.mergeCells(1, 19, 1, 21);
    }
    groupRow.getCell(zoneStartCol).value = 'ZONE REQUIREMENTS';
    worksheet.mergeCells(1, zoneStartCol, 1, zoneEndCol);
    groupRow.getCell(userStartCol).value = 'USER REQUIREMENT';
    worksheet.mergeCells(1, userStartCol, 1, userEndCol);
    groupRow.getCell(inspectionStartCol).value = 'INSPECTION DATA';
    worksheet.mergeCells(1, inspectionStartCol, 1, inspectionEndCol);

    const groupColorRanges = [
      { start: 1, end: 4, color: 'FF00AA00' },
      { start: 5, end: 9, color: 'FFFF9900' },
      { start: 10, end: 14, color: 'FF538DD5' },
      { start: 15, end: 18, color: 'FF00AA00' }
    ];
    if (isIndexTenant) {
      groupColorRanges.push({ start: 19, end: 21, color: 'FF80DEEA' });
    }
    groupColorRanges.push(
      { start: zoneStartCol, end: zoneEndCol, color: 'FFFFFF66' },
      { start: userStartCol, end: userEndCol, color: 'FFB1A0C7' },
      { start: inspectionStartCol, end: inspectionEndCol, color: 'FFB0B0B0' }
    );

    groupRow.eachCell((cell, colNumber) => {
      const range = groupColorRanges.find(r => colNumber >= r.start && colNumber <= r.end);
      const bg = range?.color || null;
      cell.font = { bold: true, color: { argb: 'FF000000' } };
      if (bg) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bg }
        };
      } else {
        cell.fill = undefined;
      }
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const headerColorRanges = [
      { start: 1, end: 4, color: 'FFCCFFCC' },
      { start: 5, end: 9, color: 'FFFFE0B2' },
      { start: 10, end: 14, color: 'FFDCE6F1' },
      { start: 15, end: 18, color: 'FFCCFFCC' }
    ];
    if (isIndexTenant) {
      headerColorRanges.push({ start: 19, end: 21, color: 'FFE0F7FA' });
    }
    headerColorRanges.push(
      { start: zoneStartCol, end: zoneEndCol, color: 'FFFFFFCC' },
      { start: userStartCol, end: userEndCol, color: 'FFE4DFEC' },
      { start: inspectionStartCol, end: inspectionEndCol, color: 'FFE0E0E0' }
    );

    const headerRow = worksheet.getRow(2);
    headerRow.eachCell((cell, colNumber) => {
      const range = headerColorRanges.find(r => colNumber >= r.start && colNumber <= r.end);
      const bg = range?.color || null;
      cell.font = { bold: true, color: { argb: 'FF000000' } };
      if (bg) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bg }
        };
      } else {
        cell.fill = undefined;
      }
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const centerAlignedColumns = new Set([
      'Temp. Range',
      'Equipment Group',
      'Equipment Category',
      'Environment',
      'Type of Protection',
      'SubGroup',
      'Temperature Class',
      'Equipment Protection Level',
      'IP rating',
      'Zone',
      'Gas / Dust Group',
      'Temp. Rating',
      'Ambient Temp',
      'Req Zone',
      'Req Gas / Dust Group',
      'Req Temp Rating',
      'Req Ambient Temp',
      'Req IP Rating',
      'Status'
    ]);

    // Sorok generálása – eszközök sorszáma (orderIndex) szerint
    let equipmentIndex = 0;

    for (const eq of equipments) {
      equipmentIndex += 1;

      const zone = eq.Zone ? zoneMap.get(eq.Zone.toString()) : null;

      const inspection = eq.lastInspectionId
        ? inspectionMap.get(eq.lastInspectionId.toString())
        : null;

      const inspectorName = inspection?.inspectorId
        ? `${inspection.inspectorId.firstName || inspection.inspectorId.name || ''} ${inspection.inspectorId.lastName || ''}`.trim()
        : '';

      const inspectionDate =
        inspection?.inspectionDate ||
        eq.lastInspectionDate ||
        null;

      const zoneNumberRaw = Array.isArray(zone?.Zone)
        ? zone.Zone.join(', ')
        : (zone?.Zone != null ? String(zone.Zone) : '');
      const zoneNumber = zoneNumberRaw ? `Zone ${zoneNumberRaw}` : '';

      const zoneSubGroup = Array.isArray(zone?.SubGroup)
        ? zone.SubGroup.join(', ')
        : (zone?.SubGroup != null ? String(zone.SubGroup) : '');

      const zoneTempParts = [];
      if (zone?.TempClass) zoneTempParts.push(zone.TempClass);
      if (typeof zone?.MaxTemp === 'number') {
        zoneTempParts.push(`${zone.MaxTemp}°C`);
      }
      const zoneTempDisplay = zoneTempParts.join(' / ');

      const ambientParts = [];
      if (zone?.AmbientTempMin != null) {
        ambientParts.push(`${zone.AmbientTempMin}°C`);
      }
      if (zone?.AmbientTempMax != null) {
        ambientParts.push(`+${zone.AmbientTempMax}°C`);
      }
      const ambientDisplay = ambientParts.join(' / ');

      // ---- Client requirement (user requirement) derived from zone.clientReq[0] ----
      const clientReq = Array.isArray(zone?.clientReq) && zone.clientReq.length
        ? zone.clientReq[0]
        : null;

      const clientReqZoneNumber = Array.isArray(clientReq?.Zone)
        ? clientReq.Zone.join(', ')
        : (clientReq?.Zone != null ? String(clientReq.Zone) : '');

      const clientReqGasDustGroup = Array.isArray(clientReq?.SubGroup)
        ? clientReq.SubGroup.join(', ')
        : (clientReq?.SubGroup != null ? String(clientReq.SubGroup) : '');

      // User requirement temp rating: same logic as zone (TempClass + MaxTemp)
      const clientReqTempParts = [];
      if (clientReq?.TempClass) {
        clientReqTempParts.push(clientReq.TempClass);
      }
      if (typeof clientReq?.MaxTemp === 'number') {
        clientReqTempParts.push(`${clientReq.MaxTemp}°C`);
      }
      const clientReqTempDisplay = clientReqTempParts.join(' / ');

      const clientReqAmbientParts = [];
      if (clientReq?.AmbientTempMin != null) {
        clientReqAmbientParts.push(`${clientReq.AmbientTempMin}°C`);
      }
      if (clientReq?.AmbientTempMax != null) {
        clientReqAmbientParts.push(`+${clientReq.AmbientTempMax}°C`);
      }
      const clientReqAmbientDisplay = clientReqAmbientParts.join(' / ');

      const clientReqIpRating = clientReq?.IpRating || '';

      const cert = resolveCertificateFromCache(certMap, eq['Certificate No']);
      const hasSpecialCondition =
        !!(cert && (cert.specCondition || cert.xcondition));

      // Certificate vs Declaration of conformity megjelenítés
      const rawCertNo = eq['Certificate No'] || '';
      let exportCertNo = rawCertNo;
      let exportDocNo = '';

      if (cert && cert.docType === 'manufacturer_declaration') {
        exportCertNo = '';
        exportDocNo = rawCertNo;
      }

      const exMarkings = Array.isArray(eq['Ex Marking']) && eq['Ex Marking'].length
        ? eq['Ex Marking']
        : [null];

      for (const marking of exMarkings) {
        const rowData = {
          '_id': eq._id ? eq._id.toString() : '',
          '#': typeof eq.orderIndex === 'number' && eq.orderIndex > 0
            ? eq.orderIndex
            : equipmentIndex,
          'TagNo': eq['TagNo'] || '',
          'EqID': eq['EqID'] || '',
          'Description': eq['Equipment Type'] || '',
          'Manufacturer': eq.Manufacturer || '',
          'Model': eq['Model/Type'] || '',
          'Serial Number': eq['Serial Number'] || '',
          'IP rating': eq['IP rating'] || '',
          'Temp. Range': eq['Max Ambient Temp'] || '',
          'EPL': marking ? marking['Equipment Protection Level'] || '' : '',
          'SubGroup': marking ? marking['Gas / Dust Group'] || '' : '',
          'Temperature Class': marking ? marking['Temperature Class'] || '' : '',
          'Protection Concept': marking ? marking['Type of Protection'] || '' : '',
          //'Equipment Group': marking ? marking['Equipment Group'] || '' : '',
         // 'Equipment Category': marking ? marking['Equipment Category'] || '' : '',
         // 'Environment': marking ? marking.Environment || '' : '',
          'Certificate No': exportCertNo,
          'Certificate Issue Date': cert?.issueDate || '',
          'Special Condition': hasSpecialCondition ? 'Yes' : 'No',
          'Declaration of conformity': exportDocNo,
          'Zone': zoneNumber,
          'Gas / Dust Group': zoneSubGroup,
          'Temp Rating': zoneTempDisplay,
          'Ambient Temp': ambientDisplay,
          'Req Zone': clientReqZoneNumber,
          'Req Gas / Dust Group': clientReqGasDustGroup,
          'Req Temp Rating': clientReqTempDisplay,
          'Req Ambient Temp': clientReqAmbientDisplay,
          'Req IP Rating': clientReqIpRating,
          'Status': eq['Compliance'] || '',
          'Inspection Date': inspectionDate
            ? new Date(inspectionDate)
            : '',
          'Inspector': inspectorName,
          'Type': inspection?.inspectionType || '',
          'Remarks': eq['Other Info'] || ''
        };

        if (isIndexTenant) {
          rowData['Skid ID'] = zone?.SkidID || '';
          rowData['Skid Description'] = zone?.SkidDescription || '';
          rowData['Project ID'] = zone?.ProjectID || '';
        }

        const row = worksheet.addRow(rowData);

        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber - 1];

          if (header === 'Status') {
            const complianceValue = rowData[header];
            const complianceColor =
              complianceValue === 'Passed'
                ? 'FF008000'
                : complianceValue === 'Failed'
                  ? 'FFFF0000'
                  : 'FF000000';
            cell.font = { color: { argb: complianceColor } , bold: true };
          }

          if (centerAlignedColumns.has(header)) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          } else {
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
          }
        });

        // Váltakozó háttérszín az adatsorokhoz (3. sortól lefelé)
        if (row.number > 2) {
          const isEven = row.number % 2 === 0;
          row.eachCell(cell => {
            if (isEven) {
              // páros sor – halvány szürke háttér
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFF5F5F5' }
              };
            } else {
              // páratlan sor – üres háttér
              cell.fill = undefined;
            }
          });
        }
      }
    }

    // Dinamikus oszlopszélesség
    if (worksheet.columns) {
      worksheet.columns.forEach(column => {
        if (!column || !column.eachCell) return;
        let maxLength = 5;
        column.eachCell({ includeEmpty: true }, cell => {
          if (cell.value) {
            const cellLength = cell.value.toString().length;
            if (cellLength > maxLength) {
              maxLength = cellLength;
            }
          }
        });
        column.width = maxLength + 2;
      });
    }

    const fileNameParts = ['exregister'];
    if (siteId) fileNameParts.push(`site_${siteId}`);
    if (zoneId) fileNameParts.push(`zone_${zoneId}`);
    const fileName = `${fileNameParts.join('_')}.xlsx`;

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=\"${fileName}\"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('❌ exportEquipmentXLSX error:', error);
    return res.status(500).json({
      message: 'Failed to export equipment register',
      error: error.message || String(error)
    });
  }
};

// GET /exreg/export-ui-xlsx — Database UI export backend verziója
exports.exportEquipmentUiXLSX = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    const { ids, zoneId, siteId, scheme, EqID } = req.query || {};
    const searchTerm = typeof req.query?.search === 'string' ? req.query.search.trim() : '';
    const filter = { tenantId };
    const andConditions = [];

    if (ids) {
      const rawIds = String(ids)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const objectIds = rawIds
        .map(id => {
          try {
            return new mongoose.Types.ObjectId(id);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (!objectIds.length) {
        return res.status(400).json({ message: 'Invalid ids parameter.' });
      }

      filter._id = { $in: objectIds };
    } else {
      if (zoneId) filter.Zone = zoneId;
      if (siteId) filter.Site = siteId;
      if (EqID) filter.EqID = EqID;
    }

    if (searchTerm) {
      const regex = new RegExp(escapeRegex(searchTerm), 'i');
      const searchConditions = SEARCHABLE_EQUIPMENT_FIELDS.map(field => ({ [field]: regex }));
      andConditions.push({ $or: searchConditions });
    }

    if (andConditions.length === 1) {
      Object.assign(filter, andConditions[0]);
    } else if (andConditions.length > 1) {
      filter.$and = andConditions;
    }

    const equipments = await Equipment.find(filter)
      .sort({ orderIndex: 1, createdAt: 1, _id: 1 })
      .lean();

    if (!equipments.length) {
      return res.status(404).json({ message: 'No equipment found for export.' });
    }

    let hideAtexSpecific = false;
    if (typeof scheme === 'string' && scheme.toUpperCase() === 'IECEX') {
      hideAtexSpecific = true;
    } else if (zoneId) {
      const zoneDoc = await Zone.findOne({ _id: zoneId, tenantId }).lean();
      hideAtexSpecific = (zoneDoc?.Scheme || '').toUpperCase() === 'IECEX';
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Database');

    const headers = [
      'EqID',
      'TagNo',
      'Manufacturer',
      'Model/Type',
      'Serial Number',
      'Equipment Type',
      'Marking',
      ...(hideAtexSpecific ? [] : ['Equipment Group', 'Equipment Category', 'Environment']),
      'Type of Protection',
      'Gas / Dust Group',
      'Temperature Class',
      'Equipment Protection Level',
      'IP rating',
      'Certificate No',
      'Max Ambient Temp',
      'Compliance',
      'Other Info'
    ];

    worksheet.columns = headers.map(header => ({ header, key: header, width: 12 }));

    worksheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFCB040' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2E2109' }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const centerAlignedColumns = [
      ...(hideAtexSpecific ? [] : ['Equipment Group', 'Equipment Category', 'Environment']),
      'Type of Protection',
      'Gas / Dust Group',
      'Temperature Class',
      'Equipment Protection Level',
      'IP rating'
    ];

    const buildRowBase = (item) => ({
      'EqID': item?.EqID || '',
      'TagNo': item?.TagNo || '',
      'Manufacturer': item?.Manufacturer || '',
      'Model/Type': item?.['Model/Type'] || '',
      'Serial Number': item?.['Serial Number'] || '',
      'Equipment Type': item?.['Equipment Type'] || '',
      'Certificate No': item?.['Certificate No'] || '',
      'Max Ambient Temp': item?.['Max Ambient Temp'] || '',
      'Compliance': item?.Compliance || '',
      'Other Info': item?.['Other Info'] || '',
      'IP rating': item?.['IP rating'] || ''
    });

    const rows = [];
    equipments.forEach(item => {
      const exMarkings = Array.isArray(item['Ex Marking']) ? item['Ex Marking'] : [];
      if (!exMarkings.length) {
        rows.push({
          ...buildRowBase(item),
          'Marking': '',
          'Equipment Group': '',
          'Equipment Category': '',
          'Environment': '',
          'Type of Protection': '',
          'Gas / Dust Group': '',
          'Temperature Class': '',
          'Equipment Protection Level': ''
        });
      } else {
        exMarkings.forEach(marking => {
          rows.push({
            ...buildRowBase(item),
            'Marking': marking?.Marking || '',
            'Equipment Group': marking?.['Equipment Group'] || '',
            'Equipment Category': marking?.['Equipment Category'] || '',
            'Environment': marking?.Environment || '',
            'Type of Protection': marking?.['Type of Protection'] || '',
            'Gas / Dust Group': marking?.['Gas / Dust Group'] || '',
            'Temperature Class': marking?.['Temperature Class'] || '',
            'Equipment Protection Level': marking?.['Equipment Protection Level'] || ''
          });
        });
      }
    });

    rows.forEach(rowData => {
      const row = worksheet.addRow(rowData);
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber - 1];
        if (header === 'Compliance') {
          const value = (rowData['Compliance'] || '').toString();
          cell.font = {
            ...cell.font,
            color:
              value === 'Passed'
                ? { argb: 'FF008000' }
                : value === 'Failed'
                  ? { argb: 'FFFF0000' }
                  : { argb: 'FF000000' }
          };
        }

        if (centerAlignedColumns.includes(header)) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }
      });
    });

    worksheet.columns?.forEach(column => {
      if (!column || !column.eachCell) {
        return;
      }
      let maxLength = 5;
      column.eachCell({ includeEmpty: true }, cell => {
        if (!cell?.value) return;
        const cellLength = cell.value.toString().length;
        if (cellLength > maxLength) {
          maxLength = cellLength;
        }
      });
      column.width = Math.min(60, maxLength + 2);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', 'attachment; filename="exregister-ui.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error('❌ exportEquipmentUiXLSX error:', error);
    return res.status(500).json({
      message: 'Failed to export UI worksheet.',
      error: error.message || String(error)
    });
  }
};

// GET /exreg/certificate-summary?zoneId=...
// Exports a certificate summary per zone grouped by certificate number
exports.exportZoneCertificateSummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { zoneId } = req.query || {};

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    if (!zoneId) {
      return res.status(400).json({ message: 'zoneId query parameter is required.' });
    }

    const zone = await Zone.findOne({ _id: zoneId, tenantId }).lean();
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found for this tenant.' });
    }

    const equipments = await Equipment.find({ tenantId, Zone: zoneId })
      .sort({ orderIndex: 1, createdAt: 1, _id: 1 })
      .lean();

    if (!equipments.length) {
      return res.status(404).json({ message: 'No equipment found for certificate summary.' });
    }

    let certMap = new Map();
    try {
      certMap = await buildCertificateCacheForTenant(tenantId);
    } catch (e) {
      console.warn('⚠️ Certificate cache build failed for exportZoneCertificateSummary:', e?.message || e);
      certMap = new Map();
    }

    const groupMap = new Map();
    equipments.forEach(eq => {
      const rawCert = typeof eq['Certificate No'] === 'string'
        ? eq['Certificate No'].trim()
        : '';
      const key = rawCert ? rawCert.toLowerCase() : '__no_cert__';
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          displayValue: rawCert || 'No certificate',
          rawValue: rawCert,
          equipments: []
        });
      }
      groupMap.get(key).equipments.push(eq);
    });

    const groups = Array.from(groupMap.values()).sort((a, b) => {
      if (a.rawValue && b.rawValue) {
        return a.rawValue.localeCompare(b.rawValue, undefined, { sensitivity: 'base', numeric: true });
      }
      if (!a.rawValue && b.rawValue) return 1;
      if (a.rawValue && !b.rawValue) return -1;
      return 0;
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Certificate summary');
    const DEFAULT_FONT_SIZE = 10;

    const columnDefinitions = [
      { key: 'item', width: 6 },
      { key: 'certificate', width: 25 },
      { key: 'description', width: 32 },
      { key: 'serial', width: 18 },
      { key: 'environment', width: 5 },
      { key: 'gasDust', width: 5 },
      { key: 'protection', width: 6 },
      { key: 'tempClass', width: 6 },
      { key: 'ambient', width: 16 },
      { key: 'ipRating', width: 12 },
      { key: 'inspection', width: 18 },
      { key: 'note', width: 20 }
    ];
    worksheet.columns = columnDefinitions;

    worksheet.getColumn(3).alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };

    const columnCount = columnDefinitions.length;
    const headerStartRow = 3;
    const headerEndRow = 4;

    const titleLines = [zone.Name || 'Zone'];
    if ((zone.Description || '').trim()) {
      titleLines.push(zone.Description.trim());
    }
    titleLines.push('Certificate summary');
    worksheet.mergeCells(1, 1, 1, columnCount);
    const titleCell = worksheet.getCell(1, 1);
    titleCell.value = titleLines.join('\n');
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    worksheet.getRow(1).height = 60;

    worksheet.getRow(2).height = 7;
    worksheet.getRow(3).height = 10;
    worksheet.getRow(4).height = 56;

    const groupFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF6' }
    };
    const headerBorder = {
      top: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      left: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      bottom: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      right: { style: 'thin', color: { argb: 'FFB4B4B4' } }
    };


    function styleHeader(cell, value) {
      cell.value = value;
      cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = groupFill;
      cell.border = headerBorder;
    }

    worksheet.mergeCells(headerStartRow, 1, headerEndRow, 1);
    styleHeader(worksheet.getCell(headerStartRow, 1), 'ITEM');

    worksheet.mergeCells(headerStartRow, 2, headerEndRow, 2);
    styleHeader(worksheet.getCell(headerStartRow, 2), 'CERTIFICATE NUMBER');

    worksheet.mergeCells(headerStartRow, 3, headerStartRow, 4);
    styleHeader(worksheet.getCell(headerStartRow, 3), 'EQUIPMENT');

    worksheet.mergeCells(headerStartRow, 5, headerStartRow, 8);
    styleHeader(worksheet.getCell(headerStartRow, 5), 'EX MARKING');

    worksheet.mergeCells(headerStartRow, 9, headerEndRow, 9);
    styleHeader(worksheet.getCell(headerStartRow, 9), 'AMBIENT TEMPERATURE');

    worksheet.mergeCells(headerStartRow, 10, headerEndRow, 10);
    styleHeader(worksheet.getCell(headerStartRow, 10), 'IP RATING');

    worksheet.mergeCells(headerStartRow, 11, headerEndRow, 11);
    styleHeader(worksheet.getCell(headerStartRow, 11), 'STATUS');

    worksheet.mergeCells(headerStartRow, 12, headerEndRow, 12);
    styleHeader(worksheet.getCell(headerStartRow, 12), 'DESCRIPTION');

    const subHeaderRow = headerStartRow + 1;
    const subHeaderFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF5F8FC' }
    };

    function styleSubHeader(col, label, options = {}) {
      worksheet.mergeCells(subHeaderRow, col, headerEndRow, col);
      const cell = worksheet.getCell(subHeaderRow, col);
      cell.value = label;
      cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
        textRotation: options.rotate ? 90 : undefined
      };
      cell.fill = subHeaderFill;
      cell.border = headerBorder;
    }

    styleSubHeader(3, 'DESCRIPTION');
    styleSubHeader(4, 'SERIAL NUMBER');
    styleSubHeader(5, 'ENVIRONMENT', { rotate: true });
    styleSubHeader(6, 'GAS / DUST GROUP', { rotate: true });
    styleSubHeader(7, 'TYPE OF PROTECTION', { rotate: true });
    styleSubHeader(8, 'TEMPERATURE CLASS', { rotate: true });

    let itemCounter = 1;
    const centerColumns = new Set([1, 5, 6, 7, 8, 9, 10, 11]);

    const getEquipmentOrderIndex = (equipment) => {
      if (!equipment) return null;
      const candidates = [
        equipment.orderIndex,
        equipment.OrderIndex,
        equipment['orderIndex'],
        equipment['OrderIndex'],
        equipment.order_index
      ];
      for (const value of candidates) {
        if (value === null || value === undefined || value === '') continue;
        const num = Number(value);
        if (Number.isFinite(num)) {
          return num;
        }
      }
      return null;
    };

    const styleDataRow = (row) => {
      row.eachCell((cell, colNumber) => {
        const horizontal = centerColumns.has(colNumber) ? 'center' : 'left';
        const wrapText = colNumber !== 1 && colNumber !== 3;
        cell.alignment = { horizontal, vertical: 'middle', wrapText };
        cell.font = { size: DEFAULT_FONT_SIZE };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
          bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }
        };
      });
    };

    groups.forEach((group, index) => {
      const eqs = group.equipments.sort((a, b) => {
        const aIndex = typeof a.orderIndex === 'number' ? a.orderIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = typeof b.orderIndex === 'number' ? b.orderIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        const aTag = (a.TagNo || '').toString();
        const bTag = (b.TagNo || '').toString();
        if (aTag && bTag && aTag !== bTag) {
          return aTag.localeCompare(bTag, undefined, { sensitivity: 'base' });
        }
        const aId = (a.EqID || a._id || '').toString();
        const bId = (b.EqID || b._id || '').toString();
        return aId.localeCompare(bId);
      });

      const groupStartRow = worksheet.lastRow ? worksheet.lastRow.number + 1 : headerEndRow + 1;

      eqs.forEach(eq => {
        const marking = Array.isArray(eq['Ex Marking']) && eq['Ex Marking'].length
          ? eq['Ex Marking'][0]
          : null;
        const orderIndexValue = getEquipmentOrderIndex(eq);

        const rowValues = [
          orderIndexValue != null ? orderIndexValue : itemCounter,
          '',
          eq['Equipment Type'] || eq.EquipmentType || eq.Description || '',
          eq['Serial Number'] || eq.SerialNumber || '',
          (marking && (marking.Environment || marking['Environment'])) || '',
          (marking && (marking['Gas / Dust Group'] || marking['Gas/Dust Group'])) || '',
          (marking && (marking['Type of Protection'] || marking['Type Of Protection'])) || '',
          (marking && (marking['Temperature Class'] || marking['Temp Class'])) || '',
          eq['Max Ambient Temp'] || '',
          eq['IP Rating'] ||
            eq['IP rating'] ||
            eq.IPRating ||
            eq.IpRating ||
            eq.ipRating ||
            eq['Req IP Rating'] ||
            '',
          eq.lastInspectionStatus || eq.Compliance || ''
        ];

        const row = worksheet.addRow(rowValues);
        styleDataRow(row);
        itemCounter += 1;
      });

      const groupEndRow = groupStartRow + eqs.length - 1;
      if (eqs.length > 0) {
        const certCell = worksheet.getCell(groupStartRow, 2);
        certCell.value = group.displayValue;
        certCell.font = { bold: true, size: DEFAULT_FONT_SIZE };
        certCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        certCell.border = {
          left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
          top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
          bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
          right: { style: 'thin', color: { argb: 'FFDDDDDD' } }
        };
        if (groupEndRow > groupStartRow) {
          worksheet.mergeCells(groupStartRow, 2, groupEndRow, 2);
        }
      }

      const certDoc = group.rawValue ? resolveCertificateFromCache(certMap, group.rawValue) : null;
      const specCondition = (certDoc?.specCondition || '').trim();

      if (specCondition) {
        const conditionFill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF9E3' }
        };
        const conditionBorder = {
          top: { style: 'thin', color: { argb: 'FFE2C470' } },
          bottom: { style: 'thin', color: { argb: 'FFE2C470' } },
          left: { style: 'thin', color: { argb: 'FFE2C470' } },
          right: { style: 'thin', color: { argb: 'FFE2C470' } }
        };
  
        // Utolsó két oszlop: STATUS és DESCRIPTION
        const statusCol = Math.max(2, columnCount - 1);
        const descriptionCol = columnCount;
        const mergeEndCol = Math.max(2, columnCount - 2);
  
        // 1) Fejléc sor: Condition of use: + STATUS + DESCRIPTION
        const headerRow = worksheet.addRow(['', 'Condition of use:']);
  
        // Condition header blokk B..mergeEndCol
        worksheet.mergeCells(headerRow.number, 2, headerRow.number, mergeEndCol);
  
        for (let col = 2; col <= mergeEndCol; col += 1) {
          const cell = worksheet.getCell(headerRow.number, col);
          cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
          cell.alignment = {
            horizontal: 'left',
            vertical: 'middle',
            wrapText: true,
            indent: 0
          };
          cell.fill = conditionFill;
          cell.border = conditionBorder;
        }
  
        // STATUS header
        const statusHeaderCell = worksheet.getCell(headerRow.number, statusCol);
        statusHeaderCell.value = 'STATUS';
        statusHeaderCell.font = { bold: true, size: DEFAULT_FONT_SIZE };
        statusHeaderCell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        statusHeaderCell.fill = conditionFill;
        statusHeaderCell.border = conditionBorder;
  
        // DESCRIPTION header
        const descriptionHeaderCell = worksheet.getCell(headerRow.number, descriptionCol);
        descriptionHeaderCell.value = 'DESCRIPTION';
        descriptionHeaderCell.font = { bold: true, size: DEFAULT_FONT_SIZE };
        descriptionHeaderCell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        descriptionHeaderCell.fill = conditionFill;
        descriptionHeaderCell.border = conditionBorder;
  
        // 2) specCondition sortörésenként külön sorba
        const normalizedSpec = String(specCondition || '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
  
        const lines = normalizedSpec
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
  
        lines.forEach((lineText) => {
          const row = worksheet.addRow(['', lineText]);

          // Condition szöveg blokk B..mergeEndCol
          worksheet.mergeCells(row.number, 2, row.number, mergeEndCol);

          for (let col = 2; col <= mergeEndCol; col += 1) {
            const cell = worksheet.getCell(row.number, col);
            cell.font = { size: DEFAULT_FONT_SIZE };
            cell.alignment = {
              horizontal: 'left',
              vertical: 'top',
              wrapText: true,
              indent: 1
            };
            cell.fill = conditionFill;
            cell.border = conditionBorder;
          }

          // STATUS és DESCRIPTION cellák – üresek, de ugyanazzal a stílussal
          const statusCell = worksheet.getCell(row.number, statusCol);
          statusCell.fill = conditionFill;
          statusCell.border = conditionBorder;
          statusCell.alignment = {
            horizontal: 'center',
            vertical: 'middle',
            wrapText: true
          };

          const descriptionCell = worksheet.getCell(row.number, descriptionCol);
          descriptionCell.fill = conditionFill;
          descriptionCell.border = conditionBorder;
          descriptionCell.alignment = {
            horizontal: 'center',
            vertical: 'middle',
            wrapText: true
          };

          // Dinamikus sormagasság – a teljes szöveg látszódjon akkor is, ha több sorba törik
          const approxLines = Math.max(
            1,
            Math.ceil(lineText.length / 265) // kb. 80 karakter / vizuális sor a B..mergeEndCol szélességen
          );
          const baseHeightPerLine = 12; // pontban
          const minHeight = 12;
          const maxHeight = 120; // ne nőjön a végtelenségig egy nagyon hosszú sor esetén

          row.height = Math.max(
            minHeight,
            Math.min(maxHeight, approxLines * baseHeightPerLine)
          );
        });
      }

      if (index < groups.length - 1) {
        const spacerRow = worksheet.addRow([]);
        spacerRow.height = 7;
      }
    });

    const autoFitColumn = (colNumber, { minWidth = 10, maxWidth = 70 } = {}) => {
      const column = worksheet.getColumn(colNumber);
      let maxLength = minWidth;
      column.eachCell({ includeEmpty: false }, cell => {
        if (cell.value == null) return;
        let text = '';
        const value = cell.value;
        if (typeof value === 'object' && value.richText) {
          text = value.richText.map(part => part.text || '').join('');
        } else if (typeof value === 'object' && typeof value.text === 'string') {
          text = value.text;
        } else {
          text = String(value);
        }
        maxLength = Math.max(maxLength, text.length + 2);
      });
      column.width = Math.min(maxWidth, Math.max(minWidth, maxLength));
    };

    autoFitColumn(3, { minWidth: 18, maxWidth: 60 });
    autoFitColumn(4, { minWidth: 14, maxWidth: 40 });

    const safeZone = slug(zone.Name || 'zone') || `zone_${zone._id}`;
    const fileName = `${safeZone.replace(/\s+/g, '_')}_certificate_summary.xlsx`;

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('❌ exportZoneCertificateSummary error:', error);
    return res.status(500).json({
      message: 'Failed to export certificate summary',
      error: error.message || String(error)
    });
  }
};

// GET /exreg/certificate-summary-compact?zoneId=...
// Ugyanaz, mint exportZoneCertificateSummary, de 1 sor / cert, aggregált ITEM és Serial Number listával
exports.exportZoneCertificateSummaryCompact = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { zoneId } = req.query || {};

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    if (!zoneId) {
      return res.status(400).json({ message: 'zoneId query parameter is required.' });
    }

    const zone = await Zone.findOne({ _id: zoneId, tenantId }).lean();
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found for this tenant.' });
    }

    const equipments = await Equipment.find({ tenantId, Zone: zoneId })
      .sort({ orderIndex: 1, createdAt: 1, _id: 1 })
      .lean();

    if (!equipments.length) {
      return res.status(404).json({ message: 'No equipment found for certificate summary.' });
    }

    let certMap = new Map();
    try {
      certMap = await buildCertificateCacheForTenant(tenantId);
    } catch (e) {
      console.warn(
        '⚠️ Certificate cache build failed for exportZoneCertificateSummaryCompact:',
        e?.message || e
      );
      certMap = new Map();
    }

    // ---- Csoportosítás cert szám szerint ----
    const groupMap = new Map();
    equipments.forEach(eq => {
      const rawCert = typeof eq['Certificate No'] === 'string'
        ? eq['Certificate No'].trim()
        : '';
      const key = rawCert ? rawCert.toLowerCase() : '__no_cert__';
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          displayValue: rawCert || 'No certificate',
          rawValue: rawCert,
          equipments: []
        });
      }
      groupMap.get(key).equipments.push(eq);
    });

    const groups = Array.from(groupMap.values()).sort((a, b) => {
      if (a.rawValue && b.rawValue) {
        return a.rawValue.localeCompare(b.rawValue, undefined, {
          sensitivity: 'base',
          numeric: true
        });
      }
      if (!a.rawValue && b.rawValue) return 1;
      if (a.rawValue && !b.rawValue) return -1;
      return 0;
    });

    // ---- Excel workbook ----
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Certificate summary (compact)');
    const DEFAULT_FONT_SIZE = 10;

    // ÚJ oszlopszerkezet:
    // CERTIFICATE NUMBER | ITEM | SERIAL NUMBER | AMBIENT | IP | ENV | GAS/DUST | TYPE | TEMP CLASS | STATUS | DESCRIPTION
    const columnDefinitions = [
      { key: 'certificate', width: 25 },
      { key: 'itemList', width: 14 },
      { key: 'serialList', width: 24 },
      { key: 'ambient', width: 16 },
      { key: 'ipRating', width: 12 },
      { key: 'environment', width: 5 },
      { key: 'gasDust', width: 8 },
      { key: 'protection', width: 8 },
      { key: 'tempClass', width: 8 },
      { key: 'status', width: 10 },
      { key: 'note', width: 20 }
    ];
    worksheet.columns = columnDefinitions;

    const columnCount = columnDefinitions.length;
    const headerStartRow = 3;
    const headerEndRow = 4;

    // Címsor
    const titleLines = [zone.Name || 'Zone'];
    if ((zone.Description || '').trim()) {
      titleLines.push(zone.Description.trim());
    }
    titleLines.push('Certificate summary (compact)');
    worksheet.mergeCells(1, 1, 1, columnCount);
    const titleCell = worksheet.getCell(1, 1);
    titleCell.value = titleLines.join('\n');
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = {
      horizontal: 'left',
      vertical: 'middle',
      wrapText: true,
      indent: 1
    };
    worksheet.getRow(1).height = 60;

    worksheet.getRow(2).height = 7;
    worksheet.getRow(3).height = 10;
    worksheet.getRow(4).height = 56;

    const groupFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF6' }
    };
    const headerBorder = {
      top: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      left: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      bottom: { style: 'thin', color: { argb: 'FFB4B4B4' } },
      right: { style: 'thin', color: { argb: 'FFB4B4B4' } }
    };

    function styleHeader(cell, value) {
      cell.value = value;
      cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true
      };
      cell.fill = groupFill;
      cell.border = headerBorder;
    }

    // Fő fejlécek
    worksheet.mergeCells(headerStartRow, 1, headerEndRow, 1);
    styleHeader(worksheet.getCell(headerStartRow, 1), 'CERTIFICATE NUMBER');

    worksheet.mergeCells(headerStartRow, 2, headerEndRow, 2);
    styleHeader(worksheet.getCell(headerStartRow, 2), 'ITEM');

    worksheet.mergeCells(headerStartRow, 3, headerEndRow, 3);
    styleHeader(worksheet.getCell(headerStartRow, 3), 'SERIAL NUMBER');

    worksheet.mergeCells(headerStartRow, 4, headerEndRow, 4);
    styleHeader(worksheet.getCell(headerStartRow, 4), 'AMBIENT TEMPERATURE');

    worksheet.mergeCells(headerStartRow, 5, headerEndRow, 5);
    styleHeader(worksheet.getCell(headerStartRow, 5), 'IP RATING');

    // EX MARKING blokk (4 oszlopot fog össze)
    worksheet.mergeCells(headerStartRow, 6, headerStartRow, 9);
    styleHeader(worksheet.getCell(headerStartRow, 6), 'EX MARKING');

    worksheet.mergeCells(headerStartRow, 10, headerEndRow, 10);
    styleHeader(worksheet.getCell(headerStartRow, 10), 'STATUS');

    worksheet.mergeCells(headerStartRow, 11, headerEndRow, 11);
    styleHeader(worksheet.getCell(headerStartRow, 11), 'DESCRIPTION');

    const subHeaderRow = headerStartRow + 1;
    const subHeaderFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF5F8FC' }
    };

    function styleSubHeader(col, label, options = {}) {
      worksheet.mergeCells(subHeaderRow, col, headerEndRow, col);
      const cell = worksheet.getCell(subHeaderRow, col);
      cell.value = label;
      cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
        textRotation: options.rotate ? 90 : undefined
      };
      cell.fill = subHeaderFill;
      cell.border = headerBorder;
    }

    // EX MARKING alfejlécek
    styleSubHeader(6, 'ENVIRONMENT', { rotate: true });
    styleSubHeader(7, 'GAS / DUST GROUP', { rotate: true });
    styleSubHeader(8, 'TYPE OF PROTECTION', { rotate: true });
    styleSubHeader(9, 'TEMPERATURE CLASS', { rotate: true });

    // Mely oszlopok középre igazítottak?
    const centerColumns = new Set([2, 4, 5, 6, 7, 8, 9, 10]);

    const getEquipmentOrderIndex = (equipment) => {
      if (!equipment) return null;
      const candidates = [
        equipment.orderIndex,
        equipment.OrderIndex,
        equipment['orderIndex'],
        equipment['OrderIndex'],
        equipment.order_index
      ];
      for (const value of candidates) {
        if (value === null || value === undefined || value === '') continue;
        const num = Number(value);
        if (Number.isFinite(num)) {
          return num;
        }
      }
      return null;
    };

    const styleDataRow = (row) => {
      row.eachCell((cell, colNumber) => {
        const horizontal = centerColumns.has(colNumber) ? 'center' : 'left';
        const wrapText = true;
        cell.alignment = { horizontal, vertical: 'middle', wrapText };
        cell.font = { size: DEFAULT_FONT_SIZE };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
          bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }
        };
      });
    };

    let itemCounter = 1;

    groups.forEach((group, index) => {
      const eqs = group.equipments.sort((a, b) => {
        const aIndex = typeof a.orderIndex === 'number' ? a.orderIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = typeof b.orderIndex === 'number' ? b.orderIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        const aTag = (a.TagNo || '').toString();
        const bTag = (b.TagNo || '').toString();
        if (aTag && bTag && aTag !== bTag) {
          return aTag.localeCompare(bTag, undefined, { sensitivity: 'base' });
        }
        const aId = (a.EqID || a._id || '').toString();
        const bId = (b.EqID || b._id || '').toString();
        return aId.localeCompare(bId);
      });

      // ---- Aggregált adatok egy certhez ----
      const itemNumbers = [];
      const serialNumbers = [];
      let ambient = '';
      let ipRating = '';

      let env = '';
      let gasDust = '';
      let protection = '';
      let tempClass = '';

      eqs.forEach(eq => {
        const orderIndexValue = getEquipmentOrderIndex(eq);
        const actualItemNumber = orderIndexValue != null ? orderIndexValue : itemCounter;
        itemNumbers.push(actualItemNumber);

        const serial =
          eq['Serial Number'] || eq.SerialNumber || '';
        if (serial) {
          serialNumbers.push(serial);
        }

        if (!ambient && eq['Max Ambient Temp']) {
          ambient = eq['Max Ambient Temp'];
        }

        const ip =
          eq['IP Rating'] ||
          eq['IP rating'] ||
          eq.IPRating ||
          eq.IpRating ||
          eq.ipRating ||
          eq['Req IP Rating'] ||
          '';
        if (!ipRating && ip) {
          ipRating = ip;
        }

        const markingArr =
          Array.isArray(eq['Ex Marking']) && eq['Ex Marking'].length
            ? eq['Ex Marking']
            : null;

        if (markingArr && !env && !gasDust && !protection && !tempClass) {
          const marking = markingArr[0];
          env = (marking && (marking.Environment || marking['Environment'])) || '';
          gasDust =
            (marking &&
              (marking['Gas / Dust Group'] || marking['Gas/Dust Group'])) ||
            '';
          protection =
            (marking &&
              (marking['Type of Protection'] || marking['Type Of Protection'])) ||
            '';
          tempClass =
            (marking &&
              (marking['Temperature Class'] || marking['Temp Class'])) ||
            '';
        }

        itemCounter += 1;
      });

      const itemList = itemNumbers.join('; ');
      const serialList = serialNumbers.join('; ');

      const rowValues = [
        group.displayValue,
        itemList,
        serialList,
        ambient,
        ipRating,
        env,
        gasDust,
        protection,
        tempClass,
        '', // STATUS üres
        ''  // DESCRIPTION üres
      ];

      const row = worksheet.addRow(rowValues);
      styleDataRow(row);

      // ---- Condition of use blokk: A oszlopban kezdődik, header indent 0, minden más indent 1 ----
      const certDoc = group.rawValue
        ? resolveCertificateFromCache(certMap, group.rawValue)
        : null;
      const specCondition = (certDoc?.specCondition || '').trim();

      if (specCondition) {
        const conditionFill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF9E3' }
        };
        const conditionBorder = {
          top: { style: 'thin', color: { argb: 'FFE2C470' } },
          bottom: { style: 'thin', color: { argb: 'FFE2C470' } },
          left: { style: 'thin', color: { argb: 'FFE2C470' } },
          right: { style: 'thin', color: { argb: 'FFE2C470' } }
        };

        const statusCol = Math.max(1, columnCount - 1);      // 10
        const descriptionCol = columnCount;                  // 11
        const mergeEndCol = Math.max(1, columnCount - 2);    // 9

        // Fejléc: Condition of use + STATUS + DESCRIPTION
        const headerRow2 = worksheet.addRow(['Condition of use:']);

        // Condition header blokk A..mergeEndCol
        worksheet.mergeCells(headerRow2.number, 1, headerRow2.number, mergeEndCol);

        for (let col = 1; col <= mergeEndCol; col += 1) {
          const cell = worksheet.getCell(headerRow2.number, col);
          cell.font = { bold: true, size: DEFAULT_FONT_SIZE };
          cell.alignment = {
            horizontal: 'left',
            vertical: 'middle',
            wrapText: true,
            indent: 0   // csak az A oszlopban lévő "Condition of use:" nem behúzott
          };
          cell.fill = conditionFill;
          cell.border = conditionBorder;
        }

        const statusHeaderCell = worksheet.getCell(headerRow2.number, statusCol);
        statusHeaderCell.value = 'STATUS';
        statusHeaderCell.font = { bold: true, size: DEFAULT_FONT_SIZE };
        statusHeaderCell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
          indent: 1
        };
        statusHeaderCell.fill = conditionFill;
        statusHeaderCell.border = conditionBorder;

        const descriptionHeaderCell = worksheet.getCell(
          headerRow2.number,
          descriptionCol
        );
        descriptionHeaderCell.value = 'DESCRIPTION';
        descriptionHeaderCell.font = { bold: true, size: DEFAULT_FONT_SIZE };
        descriptionHeaderCell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
          indent: 1
        };
        descriptionHeaderCell.fill = conditionFill;
        descriptionHeaderCell.border = conditionBorder;

        const normalizedSpec = String(specCondition || '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');

        const lines = normalizedSpec
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        lines.forEach(lineText => {
          const r = worksheet.addRow([lineText]);

          // Condition szöveg blokk A..mergeEndCol
          worksheet.mergeCells(r.number, 1, r.number, mergeEndCol);

          for (let col = 1; col <= mergeEndCol; col += 1) {
            const cell = worksheet.getCell(r.number, col);
            cell.font = { size: DEFAULT_FONT_SIZE };
            cell.alignment = {
              horizontal: 'left',
              vertical: 'top',
              wrapText: true,
              indent: 1        // minden sor, minden cella a blokkban indent 1
            };
            cell.fill = conditionFill;
            cell.border = conditionBorder;
          }

          const statusCell = worksheet.getCell(r.number, statusCol);
          statusCell.fill = conditionFill;
          statusCell.border = conditionBorder;
          statusCell.alignment = {
            horizontal: 'center',
            vertical: 'middle',
            wrapText: true,
            indent: 1
          };

          const descriptionCell2 = worksheet.getCell(r.number, descriptionCol);
          descriptionCell2.fill = conditionFill;
          descriptionCell2.border = conditionBorder;
          descriptionCell2.alignment = {
            horizontal: 'center',
            vertical: 'middle',
            wrapText: true,
            indent: 1
          };

          const approxLines = Math.max(
            1,
            Math.ceil(lineText.length / 265) // igény szerint hangolható
          );
          const baseHeightPerLine = 12;
          const minHeight = 12;
          const maxHeight = 120;

          r.height = Math.max(
            minHeight,
            Math.min(maxHeight, approxLines * baseHeightPerLine)
          );
        });
      }

      if (index < groups.length - 1) {
        const spacerRow = worksheet.addRow([]);
        spacerRow.height = 7;
      }
    });

    // Egyszerű oszlop-szélesség finomhangolás (ITEM + SERIAL NUMBER)
    const autoFitColumn = (colNumber, { minWidth = 10, maxWidth = 70 } = {}) => {
      const column = worksheet.getColumn(colNumber);
      let maxLength = minWidth;
      column.eachCell({ includeEmpty: false }, cell => {
        if (cell.value == null) return;
        let text = '';
        const value = cell.value;
        if (typeof value === 'object' && value.richText) {
          text = value.richText.map(part => part.text || '').join('');
        } else if (typeof value === 'object' && typeof value.text === 'string') {
          text = value.text;
        } else {
          text = String(value);
        }
        maxLength = Math.max(maxLength, text.length + 2);
      });
      column.width = Math.min(maxWidth, Math.max(minWidth, maxLength));
    };

    autoFitColumn(2, { minWidth: 10, maxWidth: 30 }); // ITEM lista
    autoFitColumn(3, { minWidth: 18, maxWidth: 50 }); // SERIAL lista

    const safeZone = slug(zone.Name || 'zone') || `zone_${zone._id}`;
    const fileName = `${safeZone.replace(/\s+/g, '_')}_certificate_summary_compact.xlsx`;

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('❌ exportZoneCertificateSummaryCompact error:', error);
    return res.status(500).json({
      message: 'Failed to export compact certificate summary',
      error: error.message || String(error)
    });
  }
};

// GET /exreg/:id
exports.getEquipmentById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Hiányzó tenant azonosító az auth-ból.' });
    }
    const equipment = await Equipment.findOne({ _id: id, tenantId }).lean();

    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    res.json(equipment);
  } catch (error) {
    console.error('❌ Hiba az eszköz lekérdezésekor:', error);
    res.status(500).json({ error: 'Nem sikerült lekérni az eszközt.' });
  }
};

// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó tenant.' });
    }

    const filter = { tenantId };
    const searchTerm = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const andConditions = [];

    if (req.query.Zone) {
      filter.Zone = req.query.Zone;
    } else if (req.query.noZone) {
      andConditions.push({ $or: [{ Zone: null }, { Zone: { $exists: false } }] });
    }

    if (req.query.Site) {
      filter.Site = req.query.Site;
    }

    if (req.query.EqID) {
      filter.EqID = req.query.EqID;
    }

    if (req.query.Manufacturer) {
      filter["Manufacturer"] = req.query.Manufacturer;
    }

    if (req.query.SerialNumber) {
      filter["Serial Number"] = req.query.SerialNumber;
    }

    if (req.query.TagNo) {
      filter["TagNo"] = req.query.TagNo;
    }

    if (searchTerm) {
      const regex = new RegExp(escapeRegex(searchTerm), 'i');
      const searchConditions = SEARCHABLE_EQUIPMENT_FIELDS.map(field => ({ [field]: regex }));
      andConditions.push({ $or: searchConditions });
    }

    if (andConditions.length === 1) {
      Object.assign(filter, andConditions[0]);
    } else if (andConditions.length > 1) {
      filter.$and = andConditions;
    }

    const sortField = typeof req.query.sortBy === 'string' && req.query.sortBy.trim()
      ? req.query.sortBy
      : 'orderIndex';
    const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
    const sortOptions = { [sortField]: sortDir, _id: 1 };

    const rawPageSize = parseInt(req.query.pageSize || req.query.limit, 10);
    const usePagination = Number.isFinite(rawPageSize) && rawPageSize > 0;
    const pageSize = usePagination ? Math.max(rawPageSize, 1) : null;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skipParam = parseInt(req.query.skip, 10);
    const skip = usePagination
      ? (Number.isFinite(skipParam) && skipParam >= 0 ? skipParam : (page - 1) * pageSize)
      : null;

    let query = Equipment.find(filter).sort(sortOptions);
    if (usePagination && pageSize != null) {
      query = query.skip(skip || 0).limit(pageSize);
    }

    const [equipments, totalCount] = await Promise.all([
      query.lean(),
      usePagination ? Equipment.countDocuments(filter) : Promise.resolve(null)
    ]);

    let certMap = new Map();
    try {
      certMap = await buildCertificateCacheForTenant(tenantId);
    } catch (e) {
      console.warn('⚠️ Certificate cache build failed for listEquipment:', e?.message || e);
      certMap = new Map();
    }

    const withPaths = equipments.map(eq => {
      const firstBlobUrl = eq.Pictures?.find?.(p => p.blobUrl)?.blobUrl || null;
      const certDoc = resolveCertificateFromCache(certMap, eq['Certificate No']);

      let xCondition = eq['X condition'];
      if (!xCondition || typeof xCondition !== 'object') {
        xCondition = { X: false, Specific: '' };
      } else {
        xCondition = {
          X: !!xCondition.X,
          Specific: xCondition.Specific || ''
        };
      }

      if ((!xCondition.Specific || !xCondition.Specific.trim()) && certDoc?.specCondition) {
        xCondition = {
          X: true,
          Specific: certDoc.specCondition
        };
      }

      const linkedCertificate = certDoc
        ? {
            _id: certDoc._id,
            certNo: certDoc.certNo,
            docType: certDoc.docType || 'unknown',
            specCondition: certDoc.specCondition || '',
            issueDate: certDoc.issueDate || '',
            visibility: certDoc.visibility || 'private',
            manufacturer: certDoc.manufacturer || '',
            equipment: certDoc.equipment || ''
          }
        : null;

      return {
        ...eq,
        BlobPreviewUrl: firstBlobUrl,
        'X condition': xCondition,
        _linkedCertificate: linkedCertificate,
        certificateDocType: linkedCertificate?.docType || 'unknown'
      };
    });

    if (usePagination && pageSize != null) {
      return res.json({
        items: withPaths,
        total: typeof totalCount === 'number' ? totalCount : withPaths.length,
        page,
        pageSize
      });
    }

    return res.json(withPaths);
  } catch (error) {
    console.error('Hiba történt az eszközök listázásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült lekérni az eszközöket.' });
  }
};

// Módosítás (PUT /exreg/:id)
exports.updateEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const ModifiedBy = req.userId;
    const tenantId = req.scope?.tenantId;
    if (!ModifiedBy || !tenantId) {
      return res.status(401).json({ error: 'Hiányzó jogosultság (tenant).' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    // 🔧 Ez a kulcspont: FormData-ból bontsuk ki a JSON-t
    let updatedFields = {};
    if (typeof req.body.equipmentData === 'string') {
      updatedFields = JSON.parse(req.body.equipmentData)[0];
    } else {
      updatedFields = { ...req.body };
    }

    const oldEqID = req.body.OriginalEqID || equipment.EqID;

    // X condition auto-set
    if (!updatedFields["X condition"]) {
      updatedFields["X condition"] = { X: false, Specific: '' };
    }
    if (updatedFields["X condition"].Specific && updatedFields["X condition"].Specific.trim() !== '') {
      updatedFields["X condition"].X = true;
    }

    delete updatedFields.CreatedBy;
    updatedFields.ModifiedBy = new mongoose.Types.ObjectId(ModifiedBy);

    const updatedEquipment = await Equipment.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    );

    // --- Handle blob move if Site/Zone/EqID changed ---
    try {
      const tenantName = req.scope?.tenantName || '';
      const oldSiteId = equipment.Site?.toString();
      const oldZoneId = equipment.Zone?.toString();
      const newSiteId = updatedEquipment.Site?.toString();
      const newZoneId = updatedEquipment.Zone?.toString();
      const siteChanged = oldSiteId !== newSiteId;
      const zoneChanged = oldZoneId !== newZoneId;
      const eqIdChanged = (updatedEquipment.EqID && updatedEquipment.EqID !== oldEqID);

      if (siteChanged || zoneChanged || eqIdChanged) {
        // fetch names for prefixes
        let oldSiteName = null, oldZoneName = null, newSiteName = null, newZoneName = null;
        if (oldSiteId) { const s = await Site.findById(oldSiteId).select('Name'); oldSiteName = s?.Name || null; }
        if (oldZoneId) { const z = await Zone.findById(oldZoneId).select('Name'); oldZoneName = z?.Name || null; }
        if (newSiteId) { const s2 = await Site.findById(newSiteId).select('Name'); newSiteName = s2?.Name || null; }
        if (newZoneId) { const z2 = await Zone.findById(newZoneId).select('Name'); newZoneName = z2?.Name || null; }

        const oldPrefix = buildEquipmentPrefix(tenantName, req.scope?.tenantId, oldSiteName, oldZoneName, oldEqID);
        const newPrefix = buildEquipmentPrefix(tenantName, req.scope?.tenantId, newSiteName, newZoneName, updatedEquipment.EqID);

        // ensure destination prefix exists
        try {
          await azureBlob.uploadBuffer(`${newPrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
            metadata: { kind: 'eq-keep', moved: '1' }
          });
        } catch {}

        await moveAllUnderPrefix(oldPrefix, newPrefix);

        // rewrite picture paths and urls in DB
        if (Array.isArray(updatedEquipment.Pictures) && updatedEquipment.Pictures.length) {
          let changed = false;
          updatedEquipment.Pictures.forEach(pic => {
            if (pic.blobPath && pic.blobPath.startsWith(oldPrefix + '/')) {
              const fileName = pic.blobPath.slice(oldPrefix.length + 1);
              const np = `${newPrefix}/${fileName}`;
              pic.blobPath = np;
              pic.blobUrl = azureBlob.getBlobUrl(np);
              changed = true;
            }
          });
          if (changed) {
            await updatedEquipment.save();
          }
        }
      }
    } catch (moveErr) {
      try { console.warn('⚠️ Blob move on equipment update failed:', moveErr?.message || moveErr); } catch {}
    }

    // Új képek feltöltése, ha vannak fájlok (Azure Blob)
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length > 0) {
      const tenantName = req.scope?.tenantName || '';
      let zoneDoc = null;
      let siteDoc = null;
      if (updatedEquipment.Zone && updatedEquipment.Site) {
        siteDoc = await Site.findById(updatedEquipment.Site).lean();
        zoneDoc = await Zone.findById(updatedEquipment.Zone).lean();
      }
      const zoneName = zoneDoc?.Name || (updatedEquipment.Zone ? `Zone_${updatedEquipment.Zone}` : null);
      const siteName = siteDoc?.Name || (updatedEquipment.Site ? `Site_${updatedEquipment.Site}` : null);
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, updatedEquipment.EqID);
      // Make sure target prefix exists (for brand new destinations)
      try {
        await azureBlob.uploadBuffer(`${eqPrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
          metadata: { kind: 'eq-keep' }
        });
      } catch {}
      const pictures = [];
      for (const file of files) {
        const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
        const blobPath = `${eqPrefix}/${cleanName}`;
        const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
        await azureBlob.uploadFile(file.path, blobPath, guessedType);
        pictures.push({
          name: cleanName,
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: file.size,
          uploadedAt: new Date()
        });
        try { fs.unlinkSync(file.path); } catch {}
      }
      updatedEquipment.Pictures = [...(updatedEquipment.Pictures || []), ...pictures];
      await updatedEquipment.save();
    }

    return res.json(updatedEquipment);
  } catch (error) {
    console.error('❌ Hiba módosítás közben:', error);
    return res.status(500).json({ error: 'Nem sikerült módosítani az eszközt.' });
  }
};

// Törlés (DELETE /exreg/:id)
async function deleteEquipmentInternal(equipment, tenantId, tenantName) {
  let zoneDoc = null;
  let siteDoc = null;
  if (equipment.Zone && equipment.Site) {
    zoneDoc = await Zone.findById(equipment.Zone).lean();
    siteDoc = await Site.findById(equipment.Site).lean();
  }
  const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
  const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
  const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, equipment.EqID);
  try { await azureBlob.deletePrefix(`${eqPrefix}/`); } catch (e) { console.warn('⚠️ deletePrefix failed:', e?.message); }
  // Kapcsolódó inspectionök és azok blob képeinek törlése
  try {
    const inspections = await Inspection.find({ equipmentId: equipment._id, tenantId });
    const blobPaths = new Set();
    inspections.forEach(insp => {
      (insp.attachments || []).forEach(att => {
        const raw = att?.blobPath || att?.blobUrl;
        const normalized = raw ? azureBlob.toBlobPath(raw) : '';
        if (normalized) {
          blobPaths.add(normalized);
        }
      });
    });

    for (const blobPath of blobPaths) {
      try {
        if (typeof azureBlob.deleteFile === 'function') {
          await azureBlob.deleteFile(blobPath);
        }
      } catch (e) {
        try {
          console.warn('⚠️ Failed to delete inspection blob while deleting equipment:', {
            blobPath,
            error: e?.message || e
          });
        } catch {}
      }
    }

    if (inspections.length) {
      await Inspection.deleteMany({ equipmentId: equipment._id, tenantId });
    }
  } catch (inspErr) {
    console.error('⚠️ Warning: Nem sikerült a kapcsolódó inspectionök teljes törlése equipment törléskor:', inspErr);
  }

  const deletedOrderIndex =
    typeof equipment.orderIndex === 'number' && equipment.orderIndex > 0
      ? equipment.orderIndex
      : null;

  await Equipment.deleteOne({ _id: equipment._id });

  // 🧹 Sorszámok újraszámozása az adott zónán/projekten belül
  if (deletedOrderIndex != null) {
    const scopeFilter = { tenantId, orderIndex: { $gt: deletedOrderIndex } };
    if (equipment.Zone) scopeFilter.Zone = equipment.Zone;
    if (equipment.Site) scopeFilter.Site = equipment.Site;

    await Equipment.updateMany(scopeFilter, { $inc: { orderIndex: -1 } });
  }
}

exports.deleteEquipment = async (req, res) => {
  const { id } = req.params;
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó tenant.' });
    }
    const tenantName = req.scope?.tenantName || '';
    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ error: 'Az eszköz nem található vagy nem tartozik a vállalatához.' });
    }

    await deleteEquipmentInternal(equipment, tenantId, tenantName);

    return res.json({ message: 'Az eszköz és a hozzá tartozó inspectionök sikeresen törölve.' });
  } catch (error) {
    console.error('❌ Hiba az eszköz törlésekor:', error);
    return res.status(500).json({ error: 'Nem sikerült törölni az eszközt.' });
  }
};

// Tömeges eszköz törlés (pl. 100+ egyszerre)
exports.bulkDeleteEquipment = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó tenant.' });
    }
    const tenantName = req.scope?.tenantName || '';
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'Nincs megadva törlendő eszköz lista (ids).' });
    }

    const objectIds = ids
      .map(id => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!objectIds.length) {
      return res.status(400).json({ error: 'Érvénytelen eszköz azonosítók.' });
    }

    const equipments = await Equipment.find({ _id: { $in: objectIds }, tenantId });
    if (!equipments.length) {
      return res.status(404).json({ error: 'Egyik megadott eszköz sem található vagy nem tartozik a vállalatához.' });
    }

    const results = [];
    // Limitált párhuzamosság: egyszerre max 5 törlés fusson
    const concurrency = 5;
    let index = 0;

    async function runNextBatch() {
      const batch = equipments.slice(index, index + concurrency);
      if (!batch.length) return;
      index += concurrency;

      await Promise.all(
        batch.map(async eq => {
          try {
            await deleteEquipmentInternal(eq, tenantId, tenantName);
            results.push({ id: String(eq._id), status: 'deleted' });
          } catch (err) {
            console.error('❌ Hiba az eszköz tömeges törlésekor:', err);
            results.push({
              id: String(eq._id),
              status: 'error',
              error: err?.message || 'Ismeretlen hiba a törlés során.'
            });
          }
        })
      );

      return runNextBatch();
    }

    await runNextBatch();

    const deletedCount = results.filter(r => r.status === 'deleted').length;
    const failed = results.filter(r => r.status === 'error');

    const message =
      failed.length === 0
        ? 'Minden kijelölt eszköz és kapcsolódó inspection sikeresen törölve.'
        : 'A legtöbb eszköz törlése sikeres volt, de néhánynál hiba történt.';

    return res.status(failed.length ? 207 : 200).json({
      message,
      deletedCount,
      failedCount: failed.length,
      results
    });
  } catch (error) {
    console.error('❌ Hiba a tömeges eszköz törlésekor:', error);
    return res.status(500).json({ error: 'Nem sikerült a tömeges eszköz törlés.' });
  }
};

// Gyártók lekérdezése (GET /api/manufacturers)
exports.getManufacturers = async (req, res) => {
  try {
      const tenantId = req.scope?.tenantId;
      if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });
      const manufacturers = await Equipment.distinct('Manufacturer', { tenantId });
      res.json(manufacturers);
  } catch (error) {
      console.error('Error fetching manufacturers:', error);
      res.status(500).json({ error: 'Server error while fetching manufacturers.' });
  }
};
