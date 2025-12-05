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
    const zone = await Zone.findOne({ _id: zoneId, tenantId }).lean();
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found for this tenant.' });
    }

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

        // 2) Ha nincs vagy nem érvényes _id, EqID + Zone alapján próbálunk frissíteni
        if (!equipmentDoc && payload.EqID) {
          const lookup = await Equipment.findOne({
            tenantId,
            Zone: zone._id,
            EqID: payload.EqID
          });
          if (lookup) {
            const updateData = { ...payload, ModifiedBy: userId };
            delete updateData.CreatedBy;
            delete updateData.tenantId;
            if (entry.orderIndex == null) {
              delete updateData.orderIndex;
            }
            equipmentDoc = await Equipment.findByIdAndUpdate(
              lookup._id,
              { $set: updateData },
              { new: true }
            );
            stats.updated += 1;
          }
        }

        // 3) Ha így sem találtunk, új eszközt hozunk létre
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

    worksheet.columns = headers.map(header => ({
      header,
      key: header,
      width: 2
    }));

    // ➕ Extra csoportosító sor a fejléc fölé
    // Beszúrunk egy üres sort az első helyre, így az eredeti fejléc a 2. sorba csúszik.
    worksheet.spliceRows(1, 0, []);

    const groupRow = worksheet.getRow(1);
    // Identification (A–D): _id, #, TagNo, EqID
    groupRow.getCell(1).value = 'IDENTIFICATION';
    worksheet.mergeCells(1, 1, 1, 4);
    // Equipment data (E–I)
    groupRow.getCell(5).value = 'EQUIPMENT DATA';
    worksheet.mergeCells(1, 5, 1, 9);
    // Ex Data (J–N)
    groupRow.getCell(10).value = 'EX DATA';
    worksheet.mergeCells(1, 10, 1, 14);
    // Certification (O–R)
    groupRow.getCell(15).value = 'CERTIFICATION';
    worksheet.mergeCells(1, 15, 1, 18);
    // Zone Requirements (S–V)
    groupRow.getCell(19).value = 'ZONE REQUIREMENTS';
    worksheet.mergeCells(1, 19, 1, 22);
    // User Requirement (W–AA)
    groupRow.getCell(23).value = 'USER REQUIREMENT';
    worksheet.mergeCells(1, 23, 1, 27);
    // Inspection Data (AB–AF)
    groupRow.getCell(28).value = 'INSPECTION DATA';
    worksheet.mergeCells(1, 28, 1, 32);

    // Csoportosító sor formázása (1. sor)
    groupRow.eachCell((cell, colNumber) => {
      let bg = null;

      if (colNumber >= 1 && colNumber <= 4) {
        // Identification (A–D) – zöld háttér
        bg = 'FF00AA00';
      } else if (colNumber >= 5 && colNumber <= 9) {
        // Equipment data (E–I) – narancssárga háttér
        bg = 'FFFF9900';
      } else if (colNumber >= 10 && colNumber <= 14) {
        // Ex Data (J–N) – kék háttér
        bg = 'FF538DD5';
      } else if (colNumber >= 15 && colNumber <= 18) {
        // Certification (O–R) – zöld háttér
        bg = 'FF00AA00';
      } else if (colNumber >= 19 && colNumber <= 22) {
        // Zone Requirements (S–V) – sárga háttér
        bg = 'FFFFFF66';
      } else if (colNumber >= 23 && colNumber <= 27) {
        // User Requirement (W–AA) – világos lila háttér
        bg = 'FFB1A0C7';
      } else if (colNumber >= 28 && colNumber <= 32) {
        // Inspection Data (AB–AF) – szürke háttér
        bg = 'FFB0B0B0';
      }

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

    // Fejléc formázása (2. sor – oszlopcímek, halványabb színekkel)
    const headerRow = worksheet.getRow(2);
    headerRow.eachCell((cell, colNumber) => {
      let bg = null;

      if (colNumber >= 1 && colNumber <= 4) {
        // Identification – világos zöld
        bg = 'FFCCFFCC';
      } else if (colNumber >= 5 && colNumber <= 9) {
        // Equipment data – világos narancssárga
        bg = 'FFFFE0B2';
      } else if (colNumber >= 10 && colNumber <= 14) {
        // Ex Data – világos narancssárga
        bg = 'FFDCE6F1';
      } else if (colNumber >= 15 && colNumber <= 18) {
        // Certification – világos zöld
        bg = 'FFCCFFCC';
      } else if (colNumber >= 19 && colNumber <= 22) {
        // Zone Requirements – világos sárga
        bg = 'FFFFFFCC';
      } else if (colNumber >= 23 && colNumber <= 27) {
        // User Requirement – világos lila
        bg = 'FFE4DFEC';
      } else if (colNumber >= 28 && colNumber <= 32) {
        // Inspection Data – világos szürke
        bg = 'FFE0E0E0';
      }

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

      const zoneNumber = Array.isArray(zone?.Zone)
        ? zone.Zone.join(', ')
        : (zone?.Zone != null ? String(zone.Zone) : '');

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

    if (req.query.Zone) {
      filter.Zone = req.query.Zone;
    } else if (req.query.noZone) {
      filter.$or = [{ Zone: null }, { Zone: { $exists: false } }];
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

    const equipments = await Equipment.find(filter).lean();
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
