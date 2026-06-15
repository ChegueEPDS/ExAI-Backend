// controllers/exRegisterController.js
const Equipment = require('../models/dataplate');
const Zone = require('../models/zone');
const Site = require('../models/site');
const Inspection = require('../models/inspection');
const Certificate = require('../models/certificate');
const Question = require('../models/questions');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const CustomFieldDefinition = require('../models/customFieldDefinition');
const mongoose = require('mongoose');
const fs = require('fs');
const azureBlob = require('../services/azureBlobService');
const systemSettings = require('../services/systemSettingsStore');
const mime = require('mime-types');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const unzipper = require('unzipper');
const {
  buildCertificateCacheForTenant,
  buildCertificateCacheForCertNos,
  resolveCertificateFromCache
} = require('../helpers/certificateMatchHelper');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { v4: uuidv4 } = require('uuid');
const cleanupService = require('../services/cleanupService');
const EquipmentDataVersion = require('../models/equipmentDataVersion');
const { createEquipmentDataVersion } = require('../services/equipmentVersioningService');
const { recordTombstone } = require('../services/syncTombstoneService');
const { sanitizeCustomFields } = require('../services/customFieldService');
const {
  equipmentMarkings,
  certificateNo,
  complianceStatus,
  ensureRbAssignment,
  getRbValues,
  primaryEquipmentMarking,
  protectionText,
  valuesFromEquipmentMarkings,
  zoneView
} = require('../services/rbSchemaValueService');
const { ensureRbSchema } = require('../services/schemaSeedService');
const SchemaDefinition = require('../models/schemaDefinition');
const { applySchemaCycleDefaults } = require('../services/schemaCycleService');
const { validateSchemaValues } = require('../services/schemaValidationService');
const { scheduleDashboardStatsDirty } = require('../services/dashboardSummaryService');

const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');

async function sanitizeEquipmentSchemaAssignmentsForSave(assignments, tenantId) {
  if (!Array.isArray(assignments) || !assignments.length) return assignments;
  const ids = assignments
    .map((assignment) => assignment?.schemaId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  const schemas = await SchemaDefinition.find({
    _id: { $in: ids },
    active: { $ne: false },
    $or: [{ scope: 'system' }, { scope: 'tenant', tenantId }]
  }).lean();
  const byId = new Map(schemas.map((schema) => [String(schema._id), schema]));
  return assignments.map((assignment) => {
    const schema = byId.get(String(assignment?.schemaId || ''));
    if (!schema) return assignment;
    return {
      ...assignment,
      schemaKey: schema.systemKey || null,
      values: applySchemaCycleDefaults(schema, assignment.values || {})
    };
  });
}

function preserveRbComplianceForEquipmentUpdate(assignments, existingEquipment) {
  if (!Array.isArray(assignments) || !assignments.length) return assignments;
  const existingCompliance = complianceStatus(existingEquipment) || 'NA';
  return assignments.map((assignment) => {
    if (!assignment || assignment.schemaKey !== 'rb') return assignment;
    return {
      ...assignment,
      values: {
        ...(assignment.values || {}),
        compliance: existingCompliance
      }
    };
  });
}

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
  'max ambient temp': 'Temp. Range',
  'max ta': 'Temp. Range',
  'epl': 'EPL',
  'equipment protection level': 'EPL',
  'equipment group': 'Equipment Group',
  'group': 'Equipment Group',
  'equipment category': 'Equipment Category',
  'category': 'Equipment Category',
  'environment': 'Environment',
  'subgroup': 'SubGroup',
  'sub group': 'SubGroup',
  'gas / dust group': 'SubGroup',
  'gas/dust group': 'SubGroup',
  'gas dust group': 'SubGroup',
  'temperature class': 'Temperature Class',
  'protection concept': 'Protection Concept',
  'type of protection': 'Protection Concept',
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
  'compliance': 'Status',
  'remarks': 'Remarks',
  'notes': 'Remarks',
  'note': 'Remarks',
  'comments': 'Remarks',
  'comment': 'Remarks',
  'quality check': 'Qualitycheck',
  'qualitycheck': 'Qualitycheck',
  'quality': 'Qualitycheck'
};

function customFieldValue(customFields, key) {
  if (!customFields || !key) return '';
  const value = customFields instanceof Map ? customFields.get(key) : customFields[key];
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value == null) return '';
  return String(value);
}

function isIndexTenantSlug(tenantSlug) {
  const s = String(tenantSlug || '').trim().toLowerCase();
  return s === 'index' || s === 'ind-ex';
}

function isInspExTenantSlug(tenantSlug) {
  const s = String(tenantSlug || '').trim().toLowerCase();
  return s === 'insp-ex' || s === 'inspex' || s === 'insp_ex';
}

function isProjectSkidTenantSlug(tenantSlug) {
  return isIndexTenantSlug(tenantSlug) || isInspExTenantSlug(tenantSlug);
}

function getRequestHostname(req) {
  const raw =
    req?.get?.('x-forwarded-host') ||
    req?.get?.('host') ||
    req?.headers?.host ||
    req?.hostname ||
    '';
  const host = String(raw || '').split(',')[0].trim().toLowerCase();
  return host.replace(/:\d+$/, '');
}

function isInspExRequestHost(req) {
  const host = getRequestHostname(req);
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  return host === 'insp-ex.com' || host.endsWith('.insp-ex.com');
}

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

const EQUIPMENT_LIST_SELECT_FIELDS = [
  'EqID',
  'TagNo',
  'Manufacturer',
  'Model/Type',
  'Serial Number',
  'Equipment Type',
  'IP rating',
  'Max Ambient Temp',
  'Other Info',
  'Qualitycheck',
  'CreatedBy',
  'ModifiedBy',
  'Site',
  'Zone',
  'Unit',
  'X condition',
  'Pictures.blobUrl',
  'Pictures.tag',
  'documents.blobUrl',
  'documents.type',
  'documents.tag',
  'customFields',
  'schemaAssignments',
  'orderIndex',
  'lastInspectionDate',
  'lastInspectionValidUntil',
  'lastInspectionStatus',
  'lastInspectionId',
  'operationalStatus',
  'pendingReview',
  'updatedAt',
  'createdAt'
];

const EQUIPMENT_LIST_SELECT = EQUIPMENT_LIST_SELECT_FIELDS.reduce((projection, field) => {
  projection[field] = 1;
  return projection;
}, {});

const EQUIPMENT_LIST_SORT_FIELDS = new Set([
  'orderIndex',
  'createdAt',
  'updatedAt',
  'EqID',
  'TagNo',
  'Manufacturer',
  'Serial Number',
  'lastInspectionValidUntil',
  'lastInspectionDate'
]);

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

function maxTimeMsFromEnv(name, fallbackMs) {
  const n = Number(process.env[name] ?? fallbackMs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(n, 1000), 60_000);
}

function castListCursorValue(sortField, value) {
  if (value === undefined || value === null || value === '') return null;
  if (sortField === 'createdAt' || sortField === 'updatedAt' || sortField === 'lastInspectionValidUntil' || sortField === 'lastInspectionDate') {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (sortField === 'orderIndex') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

function buildEquipmentKeysetMatch({ sortField, sortDir, afterValue, afterId }) {
  const value = castListCursorValue(sortField, afterValue);
  const id = toObjectId(afterId);
  if (value === null || !id) return null;
  const op = sortDir === -1 ? '$lt' : '$gt';
  return {
    $or: [
      { [sortField]: { [op]: value } },
      { [sortField]: value, _id: { $gt: id } }
    ]
  };
}

function buildEquipmentNextCursor(items, sortField) {
  if (!Array.isArray(items) || !items.length) return null;
  const last = items[items.length - 1];
  const value = last?.[sortField];
  return {
    afterValue: value instanceof Date ? value.toISOString() : value,
    afterId: last?._id ? String(last._id) : null
  };
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
  if (zoneId) filter.$or = [{ Unit: zoneId }, { Zone: zoneId }];
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
function buildEquipmentPrefix(tenantName, tenantId, siteId, unitId, eqId) {
  const root = buildTenantRoot(tenantName, tenantId);
  if (siteId && unitId) {
    return `${root}/projects/${siteId}/${unitId}/${slug(eqId)}`;
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

function getCellBoolean(row, headerMap, label) {
  const column = headerMap[label];
  if (!column) return null;
  const primitive = cellValueToPrimitive(row.getCell(column)?.value);
  if (primitive == null || primitive === '') return null;
  if (typeof primitive === 'boolean') return primitive;
  if (typeof primitive === 'number') return primitive !== 0;
  const value = String(primitive || '').trim().toLowerCase();
  if (!value) return null;
  if (['yes', 'y', 'true', '1', 'igen'].includes(value)) return true;
  if (['no', 'n', 'false', '0', 'nem'].includes(value)) return false;
  return null;
}

function getCellStringByIndex(row, columnIndex) {
  const primitive = cellValueToPrimitive(row.getCell(columnIndex)?.value);
  if (primitive == null) return '';
  if (primitive instanceof Date) {
    return primitive.toISOString().split('T')[0];
  }
  return String(primitive).trim();
}

// --- HEIC → JPEG konverzió helper ---
async function convertHeicBufferIfNeeded(inputBuffer, originalName, originalMime) {
  if (!inputBuffer) return { buffer: inputBuffer, name: originalName, contentType: originalMime };

  const lowerName = String(originalName || '').toLowerCase();
  const lowerMime = String(originalMime || '').toLowerCase();
  const isHeic = lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif') ||
    lowerMime === 'image/heic' ||
    lowerMime === 'image/heif';

  if (!isHeic) {
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }

  try {
    // Közvetlenül heic-convert-et használunk; a sharp HEIC plugint sok környezet nem támogatja.
    // PNG helyett JPEG-et használunk, mert az fényképeknél sokkal kisebb fájlméretet ad,
    // és online / PDF megjelenítésre általában ez az optimális.
    const jpegBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.7
    });
    const newName = originalName.replace(/\.(heic|heif)$/i, '.jpg') || 'image.jpg';
    return { buffer: jpegBuffer, name: newName, contentType: 'image/jpeg' };
  } catch (e) {
    console.warn(
      '⚠️ HEIC → PNG conversion failed in heic-convert, falling back to original buffer:',
      e?.message || e
    );
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }
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
  if (
    value.startsWith('initial detailed (index)') ||
    value.startsWith('initial detailed index') ||
    value.startsWith('initial_detailed_index') ||
    value.startsWith('initial-detailed-index') ||
    value.startsWith('initial detailed-index')
  ) return 'Initial Detailed (Index)';
  if (value.startsWith('initial detailed') || value.startsWith('initial_detailed') || value.startsWith('initial-detailed')) return 'Initial Detailed';
  if (value.startsWith('close') || value.startsWith('closed')) return 'Close';
  if (value.startsWith('detailed')) return 'Detailed';
  return 'Detailed';
}

function displayInspectionTypeForReport(type) {
  return String(type || '') === 'Initial Detailed (Index)' ? 'Initial Detailed' : (type || '');
}

function splitMultiValue(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function importCommentForField(field, prefix = '') {
  const label = field?.label || field?.key || 'Field';
  const required = field?.required ? ' Required.' : '';
  const base = `${prefix}${label}.${required}`;
  if (field?.fieldType === 'number') return `${base} Enter a number.`;
  if (field?.fieldType === 'date') return `${base} Enter a date, preferably YYYY-MM-DD.`;
  if (field?.fieldType === 'boolean') return `${base} Allowed values: Yes, No, True, False, 1, 0.`;
  if (field?.fieldType === 'select') {
    const options = (field.options || []).join(', ');
    return `${base} Select one value${options ? `: ${options}` : '.'}`;
  }
  if (field?.fieldType === 'multiselect') {
    const options = (field.options || []).join(', ');
    return `${base} Enter one or more values separated by semicolon (;).${options ? ` Allowed values: ${options}.` : ''}`;
  }
  return `${base} Free text.`;
}

async function loadEquipmentImportDynamicColumns(tenantId) {
  const [customFields, schemas] = await Promise.all([
    CustomFieldDefinition.find({
      tenantId,
      entityType: 'equipment',
      active: true
    }).sort({ createdAt: 1, label: 1 }).lean(),
    SchemaDefinition.find({
      targetLevels: 'equipment',
      $or: [
        { scope: 'system', status: 'published', active: true },
        { scope: 'tenant', tenantId, active: true }
      ]
    }).sort({ scope: 1, systemProvided: -1, name: 1 }).lean()
  ]);

  const customColumns = (customFields || []).map((field) => ({
    kind: 'custom',
    key: String(field.key),
    header: `Custom: ${field.label || field.key}`,
    aliases: [field.label, field.key, `Custom: ${field.key}`].filter(Boolean),
    field,
    group: 'CUSTOM DATA',
    comment: importCommentForField(field)
  }));

  const byKey = new Map();
  customColumns.forEach((col) => {
    if (!byKey.has(col.key)) byKey.set(col.key, col);
  });
  const schemaColumns = (schemas || [])
    .filter((schema) => schema?.systemKey !== 'rb')
    .flatMap((schema) => {
      const schemaId = String(schema._id);
      const schemaName = schema.name || schema.systemKey || schemaId;
      const prefix = `Schema: ${schemaName}`;
      const columns = [
        {
          kind: 'schema',
          schema,
          schemaId,
          key: '__enabled',
          header: prefix,
          aliases: [`Schema: ${schema.systemKey || schemaName}`, schemaName].filter(Boolean),
          field: { fieldType: 'boolean', label: schemaName },
          group: 'SCHEMA DATA',
          comment: `Attach ${schemaName} to this equipment. Allowed values: Yes, No, True, False, 1, 0.`
        },
        {
          kind: 'schema',
          schema,
          schemaId,
          key: 'cycleValue',
          header: `${prefix}: Cycle value`,
          aliases: [`${prefix}: cycleValue`],
          field: { fieldType: 'number', label: 'Cycle value' },
          group: 'SCHEMA DATA',
          comment: `Optional cycle value for ${schemaName}. Leave empty to use the schema default.`
        },
        {
          kind: 'schema',
          schema,
          schemaId,
          key: 'cycleUnit',
          header: `${prefix}: Cycle unit`,
          aliases: [`${prefix}: cycleUnit`],
          field: { fieldType: 'select', label: 'Cycle unit', options: ['day', 'month', 'year'] },
          group: 'SCHEMA DATA',
          comment: `Optional cycle unit for ${schemaName}. Allowed values: day, month, year. Leave empty to use the schema default.`
        }
      ];

      const dataFields = (Array.isArray(schema.dataFields) ? schema.dataFields : [])
        .filter((field) => field?.active !== false)
        .filter((field) => !['cycleValue', 'cycleUnit', 'startDate'].includes(String(field?.key || '')));

      dataFields
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .forEach((field) => {
          const label = field.label || field.key;
          columns.push({
            kind: 'schema',
            schema,
            schemaId,
            key: String(field.key),
            header: `${prefix}: ${label}`,
            aliases: [`${prefix}: ${field.key}`].filter(Boolean),
            field,
            group: 'SCHEMA DATA',
            comment: importCommentForField(field, `${schemaName}: `)
          });
        });

      return columns;
    });

  return [...Array.from(byKey.values()), ...schemaColumns];
}

function findColumnIndex(headerMap, column) {
  const labels = [column.header, ...(column.aliases || [])]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  for (const label of labels) {
    if (headerMap[label]) return headerMap[label];
  }
  return null;
}

function collectDynamicCustomFieldValues(row, headerMap, dynamicColumns) {
  const values = {};
  (dynamicColumns || []).filter((column) => column.kind === 'custom').forEach((column) => {
    const idx = findColumnIndex(headerMap, column);
    if (!idx) return;
    const raw = getCellStringByIndex(row, idx);
    if (raw === '') return;
    values[column.key] = column.field?.fieldType === 'multiselect' ? splitMultiValue(raw) : raw;
  });
  return values;
}

function coerceImportFieldValue(field, raw) {
  if (raw === '') return undefined;
  if (field?.fieldType === 'boolean') {
    const normalized = String(raw || '').trim().toLowerCase();
    if (['yes', 'y', 'true', '1', 'igen', 'on'].includes(normalized)) return true;
    if (['no', 'n', 'false', '0', 'nem', 'off'].includes(normalized)) return false;
    return undefined;
  }
  if (field?.fieldType === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (field?.fieldType === 'multiselect') return splitMultiValue(raw);
  return raw;
}

function collectDynamicSchemaAssignments(row, headerMap, dynamicColumns, userId) {
  const grouped = new Map();
  (dynamicColumns || []).filter((column) => column.kind === 'schema').forEach((column) => {
    const idx = findColumnIndex(headerMap, column);
    if (!idx) return;
    const raw = getCellStringByIndex(row, idx);
    if (raw === '') return;

    if (!grouped.has(column.schemaId)) {
      grouped.set(column.schemaId, {
        schema: column.schema,
        enabled: null,
        values: {},
        hasValues: false
      });
    }
    const state = grouped.get(column.schemaId);
    const value = coerceImportFieldValue(column.field, raw);
    if (column.key === '__enabled') {
      if (value !== undefined) state.enabled = value;
      return;
    }
    if (value === undefined) return;
    state.values[column.key] = value;
    state.hasValues = true;
  });

  return Array.from(grouped.values())
    .filter((state) => state.enabled !== false && (state.enabled === true || state.hasValues))
    .map((state) => {
      const { cycleValue, cycleUnit, ...schemaValues } = state.values;
      const validatedValues = validateSchemaValues(state.schema, schemaValues);
      const values = applySchemaCycleDefaults(state.schema, {
        ...validatedValues,
        ...(cycleValue !== undefined ? { cycleValue } : {}),
        ...(cycleUnit !== undefined ? { cycleUnit } : {})
      });
      return {
        schemaId: state.schema._id,
        schemaKey: state.schema.systemKey || null,
        attachedAt: new Date(),
        attachedBy: userId || null,
        values
      };
    });
}

function mergeImportedSchemaAssignments(existingAssignments = [], importedAssignments = []) {
  const next = Array.isArray(existingAssignments) ? [...existingAssignments] : [];
  (importedAssignments || []).forEach((assignment) => {
    const idx = next.findIndex((current) =>
      String(current?.schemaId || '') === String(assignment?.schemaId || '') ||
      (!!assignment?.schemaKey && current?.schemaKey === assignment.schemaKey)
    );
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        schemaId: next[idx].schemaId || assignment.schemaId,
        schemaKey: assignment.schemaKey || next[idx].schemaKey || null,
        attachedAt: next[idx].attachedAt || assignment.attachedAt,
        attachedBy: next[idx].attachedBy || assignment.attachedBy || null,
        values: {
          ...(next[idx].values || {}),
          ...(assignment.values || {})
        }
      };
    } else {
      next.push(assignment);
    }
  });
  return next;
}

function equipmentImportBaseColumns({ includeProjectSkid }) {
  const columns = [
    { header: '_id', group: 'IDENTIFICATION', width: 26, comment: 'Optional. Keep this value when updating rows exported from the system. Leave empty for new equipment.' },
    { header: '#', group: 'IDENTIFICATION', width: 8, comment: 'Optional order number inside the unit. Leave empty to auto-assign the next number.' },
    { header: 'TagNo', group: 'IDENTIFICATION', width: 16, comment: 'Optional tag number.' },
    { header: 'EqID', group: 'IDENTIFICATION', width: 24, comment: 'Equipment ID. Recommended for every row.' },
    { header: 'Description', group: 'EQUIPMENT DATA', width: 24, comment: 'Equipment type / description, for example electric motor.' },
    { header: 'Manufacturer', group: 'EQUIPMENT DATA', width: 22, comment: 'Manufacturer name.' },
    { header: 'Model', group: 'EQUIPMENT DATA', width: 20, comment: 'Model or type designation.' },
    { header: 'Serial Number', group: 'EQUIPMENT DATA', width: 20, comment: 'Serial number.' },
    { header: 'IP rating', group: 'EQUIPMENT DATA', width: 14, comment: 'Ingress protection, for example IP66.' },
    { header: 'Temp. Range', group: 'EQUIPMENT DATA', width: 18, comment: 'Ambient temperature range, for example -40 / +80°C.' },
    { header: 'Qualitycheck', group: 'EQUIPMENT DATA', width: 16, comment: 'Optional quality check flag. Allowed values: Yes, No, True, False, 1, 0.' },
    { header: 'EPL', group: 'EX DATA', width: 14, comment: 'Equipment Protection Level, for example Ga, Gb, Gc, Da, Db, Dc.' },
    { header: 'Equipment Group', group: 'EX DATA', width: 18, comment: 'Equipment group, for example I, II or III.' },
    { header: 'Equipment Category', group: 'EX DATA', width: 20, comment: 'Equipment category, for example 1G, 2G, 3G, 1D, 2D or 3D.' },
    { header: 'Environment', group: 'EX DATA', width: 16, comment: 'Environment, for example G, D or GD.' },
    { header: 'SubGroup', group: 'EX DATA', width: 16, comment: 'Gas/dust subgroup, for example IIA, IIB, IIC, IIIA, IIIB, IIIC. Multiple values may be separated by comma or slash.' },
    { header: 'Temperature Class', group: 'EX DATA', width: 18, comment: 'Temperature class, for example T1, T2, T3, T4, T5, T6.' },
    { header: 'Protection Concept', group: 'EX DATA', width: 22, comment: 'Type of protection, for example Ex d, Ex e, Ex i, Ex t. Use the same notation as on the dataplate.' },
    { header: 'Certificate No', group: 'CERTIFICATION', width: 24, comment: 'Certificate number. If this is empty, Declaration of conformity may be used as certificate reference.' },
    { header: 'Declaration of conformity', group: 'CERTIFICATION', width: 28, comment: 'Manufacturer declaration number. Used as certificate reference when Certificate No is empty.' }
  ];
  if (includeProjectSkid) {
    columns.push(
      { header: 'Skid ID', group: 'PROJECT / SKID', width: 18, comment: 'Optional project/skid context. When filled, the unit skid value is updated from the latest non-empty value.' },
      { header: 'Skid Description', group: 'PROJECT / SKID', width: 28, comment: 'Optional project/skid description. When filled, the unit skid description is updated from the latest non-empty value.' },
      { header: 'Project ID', group: 'PROJECT / SKID', width: 18, comment: 'Optional project ID. When filled, the unit project value is updated from the latest non-empty value.' }
    );
  }
  return columns;
}

function equipmentImportInspectionColumns() {
  return [
    { header: 'Inspection Date', group: 'INSPECTION DATA', width: 18, comment: 'Optional. Enter a date, preferably YYYY-MM-DD. If Status is Passed, an inspection can be created from this date.' },
    { header: 'Type', group: 'INSPECTION DATA', width: 18, comment: 'Optional inspection type. Allowed values: Detailed, Visual, Initial Detailed, Initial Detailed (Index), Close.' },
    { header: 'Status', group: 'INSPECTION DATA', width: 14, comment: 'Allowed values: Passed, Failed, NA. Passed with Inspection Date creates an inspection.' },
    { header: 'Remarks', group: 'INSPECTION DATA', width: 28, comment: 'Free text remarks imported into the inspection-level ITR remarks.' }
  ];
}

function groupColor(group) {
  return {
    'IDENTIFICATION': 'FF00AA00',
    'EQUIPMENT DATA': 'FFFF9900',
    'EX DATA': 'FF538DD5',
    'CERTIFICATION': 'FF00AA00',
    'PROJECT / SKID': 'FF80DEEA',
    'CRITERIA ASSIGNMENT': 'FF8E7CC3',
    'SCHEMA DATA': 'FF8E7CC3',
    'INSPECTION DATA': 'FFB0B0B0',
    'CUSTOM DATA': 'FF6AA84F'
  }[group] || 'FF9FC5E8';
}

function groupLightColor(group) {
  return {
    'IDENTIFICATION': 'FFCCFFCC',
    'EQUIPMENT DATA': 'FFFFE0B2',
    'EX DATA': 'FFDCE6F1',
    'CERTIFICATION': 'FFCCFFCC',
    'PROJECT / SKID': 'FFE0F7FA',
    'CRITERIA ASSIGNMENT': 'FFEADCF8',
    'SCHEMA DATA': 'FFEADCF8',
    'INSPECTION DATA': 'FFE0E0E0',
    'CUSTOM DATA': 'FFEAF4E4'
  }[group] || 'FFD9EAD3';
}

function applyImportTemplateStyles(worksheet, columns) {
  worksheet.views = [{ state: 'frozen', ySplit: 2 }];
  worksheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length }
  };

  const groupRow = worksheet.getRow(1);
  const headerRow = worksheet.getRow(2);
  groupRow.height = 24;
  headerRow.height = 34;

  let start = 1;
  while (start <= columns.length) {
    const group = columns[start - 1].group || '';
    let end = start;
    while (end + 1 <= columns.length && columns[end].group === group) end += 1;
    groupRow.getCell(start).value = group;
    if (end > start) worksheet.mergeCells(1, start, 1, end);
    for (let col = start; col <= end; col += 1) {
      const cell = groupRow.getCell(col);
      cell.font = { bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupColor(group) } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
      };
    }
    start = end + 1;
  }

  columns.forEach((column, idx) => {
    const colNumber = idx + 1;
    const cell = headerRow.getCell(colNumber);
    cell.value = column.header;
    cell.note = column.comment || 'Enter the value for this column.';
    cell.font = { bold: true, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupLightColor(column.group) } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      left: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      bottom: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      right: { style: 'thin', color: { argb: 'FFB7B7B7' } }
    };
    worksheet.getColumn(colNumber).width = column.width || Math.min(Math.max(String(column.header).length + 4, 14), 34);
  });

  for (let rowNumber = 3; rowNumber <= 250; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    row.height = 20;
    columns.forEach((column, idx) => {
      const cell = row.getCell(idx + 1);
      cell.alignment = { vertical: 'middle', wrapText: false };
      if (rowNumber % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      }
    });
  }
}

function applyEquipmentExportHeaderStyles(worksheet, columns) {
  worksheet.views = [{ state: 'frozen', ySplit: 2 }];
  worksheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length }
  };

  const groupRow = worksheet.getRow(1);
  const headerRow = worksheet.getRow(2);
  groupRow.height = 24;
  headerRow.height = 34;

  let start = 1;
  while (start <= columns.length) {
    const group = columns[start - 1].group || '';
    let end = start;
    while (end + 1 <= columns.length && columns[end].group === group) end += 1;
    groupRow.getCell(start).value = group;
    if (end > start) worksheet.mergeCells(1, start, 1, end);
    for (let col = start; col <= end; col += 1) {
      const cell = groupRow.getCell(col);
      cell.font = { bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupColor(group) } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
      };
    }
    start = end + 1;
  }

  columns.forEach((column, idx) => {
    const colNumber = idx + 1;
    const cell = headerRow.getCell(colNumber);
    cell.value = column.header;
    cell.note = column.comment || 'Exported equipment data.';
    cell.font = { bold: true, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupLightColor(column.group) } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      left: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      bottom: { style: 'thin', color: { argb: 'FFB7B7B7' } },
      right: { style: 'thin', color: { argb: 'FFB7B7B7' } }
    };
    worksheet.getColumn(colNumber).width = column.width || Math.min(Math.max(String(column.header).length + 4, 14), 42);
  });
}

function equipmentListExportGroupForHeader(header) {
  if (['_id', '#', 'TagNo', 'EqID'].includes(header)) return 'IDENTIFICATION';
  if ([
    'Description',
    'Equipment Type',
    'Manufacturer',
    'Model',
    'Model/Type',
    'Serial Number',
    'IP rating',
    'Temp. Range',
    'Max Ambient Temp',
    'Qualitycheck'
  ].includes(header)) return 'EQUIPMENT DATA';
  if ([
    'Marking',
    'EPL',
    'Equipment Group',
    'Equipment Category',
    'Environment',
    'SubGroup',
    'Type of Protection',
    'Gas / Dust Group',
    'Temperature Class',
    'Equipment Protection Level',
    'Protection Concept'
  ].includes(header)) return 'EX DATA';
  if ([
    'Certificate No',
    'Certificate Issue Date',
    'Special Condition',
    'Declaration of conformity'
  ].includes(header)) return 'CERTIFICATION';
  if ([
    'Zone',
    'Gas / Dust Group',
    'Temp Rating',
    'Ambient Temp'
  ].includes(header)) return 'ZONE REQUIREMENTS';
  if (header.startsWith('Req ')) return 'USER REQUIREMENT';
  if ([
    'Inspection Date',
    'Inspector',
    'Type',
    'Status',
    'Compliance',
    'Remarks',
    'Other Info'
  ].includes(header)) return 'INSPECTION DATA';
  if (header.startsWith('Custom:')) return 'CUSTOM DATA';
  if (header.startsWith('Schema:')) return 'SCHEMA DATA';
  if (['Skid ID', 'Skid Description', 'Project ID'].includes(header)) return 'PROJECT / SKID';
  return 'CUSTOM DATA';
}

function buildEquipmentListExportColumns(headers) {
  return headers.map((header) => ({
    header,
    group: equipmentListExportGroupForHeader(header),
    width: Math.min(Math.max(String(header).length + 4, 14), 42),
    comment: 'Exported equipment data.'
  }));
}

async function loadEquipmentExportSchemaColumns(tenantId) {
  return (await loadEquipmentImportDynamicColumns(tenantId)).filter((column) => column.kind === 'schema');
}

function schemaAssignmentForExport(entity, schema) {
  const assignments = Array.isArray(entity?.schemaAssignments) ? entity.schemaAssignments : [];
  return assignments.find((assignment) =>
    String(assignment?.schemaId || '') === String(schema?._id || '') ||
    (!!schema?.systemKey && assignment?.schemaKey === schema.systemKey)
  ) || null;
}

function exportSchemaFieldValue(value) {
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (value == null) return '';
  return value;
}

function appendSchemaExportValues(rowData, entity, schemaColumns) {
  const assignmentCache = new Map();
  (schemaColumns || []).forEach((column) => {
    if (!assignmentCache.has(column.schemaId)) {
      assignmentCache.set(column.schemaId, schemaAssignmentForExport(entity, column.schema));
    }
    const assignment = assignmentCache.get(column.schemaId);
    if (column.key === '__enabled') {
      rowData[column.header] = assignment ? 'Yes' : '';
      return;
    }
    rowData[column.header] = assignment
      ? exportSchemaFieldValue(assignment.values?.[column.key])
      : '';
  });
  return rowData;
}

function hasMeaningfulExMarking(marking) {
  if (!marking || typeof marking !== 'object') return false;
  return Object.entries(marking).some(([key, value]) =>
    key !== '_id' && String(value || '').trim()
  );
}

async function applyRbSchemaFromLegacyEquipmentFields(payload, userId = null, existingEquipment = null) {
  if (!payload || typeof payload !== 'object') return;

  const markings = (Array.isArray(payload['Ex Marking']) ? payload['Ex Marking'] : [])
    .filter(hasMeaningfulExMarking);
  const certificateNo = String(payload['Certificate No'] || payload.CertificateNo || '').trim();
  const compliance = String(payload.Compliance || '').trim();
  const hasCompliance = compliance && compliance !== 'NA';

  if (!markings.length && !certificateNo && !hasCompliance) return;

  if (!Array.isArray(payload.schemaAssignments)) {
    payload.schemaAssignments = Array.isArray(existingEquipment?.schemaAssignments)
      ? [...existingEquipment.schemaAssignments]
      : [];
  }

  const rbSchema = await ensureRbSchema();
  ensureRbAssignment(payload, rbSchema, {
    ...valuesFromEquipmentMarkings(markings),
    certificateNo,
    compliance: compliance || 'NA'
  }, userId);

  delete payload['Ex Marking'];
  delete payload['Certificate No'];
  delete payload.CertificateNo;
  delete payload.Compliance;
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
  const protection = protectionText(equipmentDoc) || '';
  if (!protection) return [];

  try {
    // Use the same canonicalization set as Questions.protectionTypes (handles multi-word values like "op is").
    // eslint-disable-next-line global-require
    const { KNOWN_SET_LOWER, normalizeProtectionTypes } = require('../helpers/protectionTypes');
    const tokens = normalizeProtectionTypes(protection).map(v => String(v).trim().toLowerCase());
    const hasKnown = tokens.some(t => KNOWN_SET_LOWER.has(t));
    if (!hasKnown && tokens.length) {
      return Array.from(new Set(['d', 'e', ...tokens]));
    }
    return tokens;
  } catch {
    return String(protection)
      .split(/[;,|/ ]+/)
      .map(token => token.trim().toLowerCase())
      .filter(Boolean);
  }
}

function listDisplay(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value != null ? String(value) : '';
}

function zoneRbDisplays(zone) {
  const rb = zoneView(zone);
  const tempParts = [];
  if (rb.TempClass) tempParts.push(rb.TempClass);
  if (typeof rb.MaxTemp === 'number') tempParts.push(`${rb.MaxTemp}°C`);
  const ambientParts = [];
  if (rb.AmbientTempMin != null) ambientParts.push(`${rb.AmbientTempMin}°C`);
  if (rb.AmbientTempMax != null) ambientParts.push(`+${rb.AmbientTempMax}°C`);
  return {
    ...rb,
    zoneNumber: rb.Zone?.length ? `Zone ${listDisplay(rb.Zone)}` : '',
    zoneNumberRaw: listDisplay(rb.Zone),
    subGroup: listDisplay(rb.SubGroup),
    temp: tempParts.join(' / '),
    ambient: ambientParts.join(' / '),
    ipRating: rb.IPRating || '',
    epl: listDisplay(rb.EPL),
    clientReq: Array.isArray(rb.clientReq) ? rb.clientReq : []
  };
}

function clientReqDisplays(clientReq) {
  const req = clientReq || {};
  const tempParts = [];
  if (req.TempClass) tempParts.push(req.TempClass);
  if (typeof req.MaxTemp === 'number') tempParts.push(`${req.MaxTemp}°C`);
  const ambientParts = [];
  if (req.AmbientTempMin != null) ambientParts.push(`${req.AmbientTempMin}°C`);
  if (req.AmbientTempMax != null) ambientParts.push(`+${req.AmbientTempMax}°C`);
  return {
    zone: listDisplay(req.Zone),
    subGroup: listDisplay(req.SubGroup),
    temp: tempParts.join(' / '),
    ambient: ambientParts.join(' / ')
  };
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
  if (!certNoRaw || !String(certNoRaw).trim()) return null;
  try {
    const certMap = await buildCertificateCacheForTenant(tenantId);
    const hit = resolveCertificateFromCache(certMap, certNoRaw);
    if (!hit) return null;
    return { specCondition: hit.specCondition, certNo: hit.certNo };
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
    const certNo = certificateNo(equipmentDoc);
    if (certNo) {
      const certificate = await findCertificateByCertNoForTenant(certNo, tenantId);
      text = certificate?.specCondition?.trim() || '';
    }
  }

  if (!text) return null;

  return {
    questionId: undefined,
    reference: 'SC1',
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

function deriveInspectionQuestionReference(input = {}) {
  const explicit = String(input.reference || '').trim();
  if (explicit) return explicit;
  const table = String(input.table || input.Table || '').trim();
  const number = input.number ?? input.Number;
  if (table === 'SC' || input.equipmentType === 'Special Condition') return `SC${number || 1}`;
  if (table && (number || number === 0)) return `${table}-${number}`;
  if (number || number === 0) return `${number}`;
  return '';
}

// 📥 Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  try {
    const CreatedBy = req.userId;
    const tenantId = req.scope?.tenantId;
    const tenantSlug = (req.scope?.tenantName || '').toLowerCase();
    const isIndexTenant = isIndexTenantSlug(tenantSlug);
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
      const eqId = rawEqId;

      // Blob elérési útvonalhoz kell egy azonosító, de az EqID mezőt nem töltjük ki automatikusan,
      // ha üresen jött (így a DB-ben az EqID üres maradhat).
      const eqIdForBlob = rawEqId || new mongoose.Types.ObjectId().toString();

      // ⚙️ EqID már NEM egyedi kulcs: csak _id alapján frissítünk
      let existingEquipment = null;
      if (_id) {
        existingEquipment = await Equipment.findOne({ _id, tenantId });
      }

      const siteIdForPrefix = equipment.Site ? String(equipment.Site) : null;
      const unitIdForPrefix = equipment.Unit || equipment.Zone ? String(equipment.Unit || equipment.Zone) : null;
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteIdForPrefix, unitIdForPrefix, eqIdForBlob);

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
        const originalName = file.originalname.split('__')[1] || file.originalname;
        const safeOriginal = cleanFileName(originalName);
        const srcBuffer = fs.readFileSync(file.path);
        const { buffer, name: convertedName, contentType } =
          await convertHeicBufferIfNeeded(
            srcBuffer,
            safeOriginal,
            file.mimetype || mime.lookup(safeOriginal) || 'application/octet-stream'
          );

        const cleanName = convertedName;
        const blobPath = `${eqPrefix}/${cleanName}`;
        const guessedType = contentType || 'image/png';
        await azureBlob.uploadBuffer(blobPath, buffer, guessedType);
        pictures.push({
          name: cleanName,
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: buffer.length,
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
      if (!updateFields.Unit && updateFields.Zone) {
        updateFields.Unit = updateFields.Zone;
      }

      // Ha az UI nem ad meg orderIndex-et, automatikusan kiosztjuk a következő szabad sorszámot
      if (updateFields.orderIndex == null) {
        const siteIdForIndex = equipment.Site || null;
        const zoneIdForIndex = equipment.Zone || null;
        updateFields.orderIndex = await getNextOrderIndex(tenantId, siteIdForIndex, zoneIdForIndex);
      }

      if (Object.prototype.hasOwnProperty.call(updateFields, 'customFields')) {
        updateFields.customFields = await sanitizeCustomFields({
          tenantId,
          entityType: 'equipment',
          values: updateFields.customFields
        });
      }

      await applyRbSchemaFromLegacyEquipmentFields(updateFields, CreatedBy, existingEquipment);

      if (existingEquipment) {
        updateFields.ModifiedBy = CreatedBy;
        const saved = await Equipment.findByIdAndUpdate(
          existingEquipment._id,
          { $set: updateFields },
          { new: true }
        );
        try {
          await createEquipmentDataVersion({
            tenantId,
            equipmentId: existingEquipment._id,
            changedBy: CreatedBy,
            source: 'update',
            oldSnapshot: existingEquipment.toObject({ depopulate: true }),
            newSnapshot: saved?.toObject?.({ depopulate: true }) || saved
          });
        } catch (versionErr) {
          try {
            console.warn(
              '⚠️ Failed to write equipment data version (createEquipment update):',
              versionErr?.message || versionErr
            );
          } catch {}
        }
        results.push(saved);
      } else {
        updateFields.CreatedBy = CreatedBy;
        const newEquipment = new Equipment(updateFields);
        const saved = await newEquipment.save();
        try {
          await createEquipmentDataVersion({
            tenantId,
            equipmentId: saved._id,
            changedBy: CreatedBy,
            source: 'create',
            oldSnapshot: {},
            newSnapshot: saved?.toObject?.({ depopulate: true }) || saved
          });
        } catch (versionErr) {
          try {
            console.warn(
              '⚠️ Failed to write equipment data version (createEquipment create):',
              versionErr?.message || versionErr
            );
          } catch {}
        }
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
    const siteIdForPrefix = equipment.Site ? String(equipment.Site) : null;
    const unitIdForPrefix = equipment.Unit || equipment.Zone ? String(equipment.Unit || equipment.Zone) : null;
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteIdForPrefix, unitIdForPrefix, equipment.EqID);

    console.log('📥 Képfeltöltési kérés érkezett:', {
      equipmentId: req.params.id,
      user: req.user?.email || req.userId,
      filesCount: Array.isArray(req.files) ? req.files.length : 0
    });

    const pictures = [];
    for (const file of files) {
      const originalName = file.originalname.split('__')[1] || file.originalname;
      const safeOriginal = cleanFileName(originalName);
      const srcBuffer = fs.readFileSync(file.path);
      const { buffer, name: convertedName, contentType } =
        await convertHeicBufferIfNeeded(
          srcBuffer,
          safeOriginal,
          file.mimetype || mime.lookup(safeOriginal) || 'application/octet-stream'
        );

      const cleanName = convertedName;
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = contentType || 'image/png';
      await azureBlob.uploadBuffer(blobPath, buffer, guessedType);
      pictures.push({
        name: cleanName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: buffer.length,
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

    const siteIdForPrefix = equipment.Site ? String(equipment.Site) : null;
    const unitIdForPrefix = equipment.Unit || equipment.Zone ? String(equipment.Unit || equipment.Zone) : null;
    const eqPrefix = buildEquipmentPrefix(
      tenantName,
      tenantId,
      siteIdForPrefix,
      unitIdForPrefix,
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
      const safeOriginal = cleanFileName(file.originalname);
      const srcBuffer = fs.readFileSync(file.path);
      const { buffer, name: convertedName, contentType } =
        await convertHeicBufferIfNeeded(
          srcBuffer,
          safeOriginal,
          file.mimetype || mime.lookup(safeOriginal) || 'application/octet-stream'
        );

      const cleanName = convertedName;
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = contentType || 'application/octet-stream';

      await azureBlob.uploadBuffer(blobPath, buffer, guessedType);

      const typeValue = String(guessedType).startsWith('image') ? 'image' : 'document';
      docs.push({
        name: cleanName,
        alias: aliasFromForm || cleanName,
        type: typeValue,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: buffer.length,
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

exports.downloadEquipmentImportTemplate = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    const tenantName = (req.scope?.tenantName || '').toLowerCase();
    const includeProjectSkid = isProjectSkidTenantSlug(tenantName) || isInspExRequestHost(req);
    const dynamicColumns = await loadEquipmentImportDynamicColumns(tenantId);
    const columns = [
      ...equipmentImportBaseColumns({ includeProjectSkid }),
      ...dynamicColumns.map((column) => ({
        header: column.header,
        group: column.group || 'CUSTOM DATA',
        width: Math.min(Math.max(String(column.header).length + 4, 18), 42),
        comment: column.comment
      })),
      ...equipmentImportInspectionColumns()
    ];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'InspEx';
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet('Equipment import');
    worksheet.columns = columns.map((column) => ({ header: column.header, key: column.header, width: column.width }));
    worksheet.spliceRows(1, 0, []);
    applyImportTemplateStyles(worksheet, columns);

    const statusColumn = columns.findIndex((c) => c.header === 'Status') + 1;
    const typeColumn = columns.findIndex((c) => c.header === 'Type') + 1;
    if (statusColumn > 0) {
      worksheet.dataValidations.add(`${worksheet.getColumn(statusColumn).letter}3:${worksheet.getColumn(statusColumn).letter}250`, {
        type: 'list',
        allowBlank: true,
        formulae: ['"Passed,Failed,NA"']
      });
    }
    if (typeColumn > 0) {
      worksheet.dataValidations.add(`${worksheet.getColumn(typeColumn).letter}3:${worksheet.getColumn(typeColumn).letter}250`, {
        type: 'list',
        allowBlank: true,
        formulae: ['"Detailed,Visual,Initial Detailed,Initial Detailed (Index),Close"']
      });
    }
    const qualityColumn = columns.findIndex((c) => c.header === 'Qualitycheck') + 1;
    if (qualityColumn > 0) {
      worksheet.dataValidations.add(`${worksheet.getColumn(qualityColumn).letter}3:${worksheet.getColumn(qualityColumn).letter}250`, {
        type: 'list',
        allowBlank: true,
        formulae: ['"Yes,No,True,False,1,0"']
      });
    }

    dynamicColumns.forEach((column) => {
      const colIdx = columns.findIndex((c) => c.header === column.header) + 1;
      if (colIdx <= 0) return;
      const letter = worksheet.getColumn(colIdx).letter;
      if (column.field?.fieldType === 'boolean') {
        worksheet.dataValidations.add(`${letter}3:${letter}250`, {
          type: 'list',
          allowBlank: true,
          formulae: ['"Yes,No,True,False,1,0"']
        });
      } else if (column.field?.fieldType === 'select' && Array.isArray(column.field.options) && column.field.options.length) {
        const csv = column.field.options.join(',');
        if (csv.length <= 240) {
          worksheet.dataValidations.add(`${letter}3:${letter}250`, {
            type: 'list',
            allowBlank: true,
            formulae: [`"${csv.replace(/"/g, '""')}"`]
          });
        }
      }
    });

    const instructions = workbook.addWorksheet('Instructions');
    instructions.columns = [
      { header: 'Topic', key: 'topic', width: 24 },
      { header: 'Guidance', key: 'guidance', width: 90 }
    ];
    instructions.addRow({
      topic: 'Header help',
      guidance: 'Hover over cells in the header row on the Equipment import sheet to see allowed values and formatting guidance.'
    });
    instructions.addRow({
      topic: 'Multi-select values',
      guidance: 'Use semicolon (;) between multiple values, for example: Option A; Option B.'
    });
    instructions.addRow({
      topic: 'Schema columns',
      guidance: 'Schema columns show every equipment-level schema available to the tenant. Fill the Schema column with Yes or fill any schema value column to attach it; No or empty schema columns are ignored.'
    });
    instructions.addRow({
      topic: 'Updates',
      guidance: 'Keep the _id column when updating equipment exported from the system. Leave _id empty to create new equipment.'
    });
    instructions.getRow(1).font = { bold: true };
    instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
    res.setHeader('Content-Disposition', 'attachment; filename="equipment-import-template.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('❌ downloadEquipmentImportTemplate error:', err);
    return res.status(500).json({
      message: 'Failed to generate equipment import template.',
      error: err.message || String(err)
    });
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
    const includeProjectSkid = isProjectSkidTenantSlug(tenantName) || isInspExRequestHost(req);
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
    const dynamicImportColumns = await loadEquipmentImportDynamicColumns(tenantId);

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
      const qualitycheck = getCellBoolean(row, headerInfo.headerMap, 'Qualitycheck');
      const certificateNo = getCellString(row, headerInfo.headerMap, 'Certificate No');
      const declarationNo = getCellString(row, headerInfo.headerMap, 'Declaration of conformity');
      const remarks = getCellString(row, headerInfo.headerMap, 'Remarks');
      const epl = getCellString(row, headerInfo.headerMap, 'EPL');
      const equipmentGroup = getCellString(row, headerInfo.headerMap, 'Equipment Group');
      const equipmentCategory = getCellString(row, headerInfo.headerMap, 'Equipment Category');
      const environment = getCellString(row, headerInfo.headerMap, 'Environment');
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
      if (includeProjectSkid) {
        skidId = getCellString(row, headerInfo.headerMap, 'Skid ID');
        skidDescription = getCellString(row, headerInfo.headerMap, 'Skid Description');
        projectId = getCellString(row, headerInfo.headerMap, 'Project ID');
        if (skidId) latestSkidId = skidId;
        if (skidDescription) latestSkidDescription = skidDescription;
        if (projectId) latestProjectId = projectId;
      }
      const customFieldsRaw = collectDynamicCustomFieldValues(row, headerInfo.headerMap, dynamicImportColumns);
      let schemaAssignmentsRaw = [];
      try {
        schemaAssignmentsRaw = collectDynamicSchemaAssignments(row, headerInfo.headerMap, dynamicImportColumns, userId);
      } catch (schemaError) {
        parseErrors.push({
          row: rowNumber,
          message: schemaError.message || String(schemaError)
        });
        return;
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
        qualitycheck == null ? '' : String(qualitycheck),
        certificateNo,
        declarationNo,
        remarks,
        ...Object.values(customFieldsRaw),
        ...schemaAssignmentsRaw.flatMap((assignment) => Object.values(assignment.values || {}))
      ].some(Boolean);

      const rowHasExData = [epl, equipmentGroup, equipmentCategory, environment, subGroup, tempClass, protectionConcept].some(Boolean);

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
            Qualitycheck: qualitycheck === true,
            'Other Info': remarks || '',
            'Ex Marking': [],
            'X condition': { X: false, Specific: '' },
            customFields: {}
          },
          inspectionDate: inspectionDate || null,
          inspectionStatus,
          inspectionType: inspectionType || null,
          schemaAssignments: [],
          inspectionRemarks: remarks || '',
          rbCertificateNo: certificateNo || declarationNo || '',
          rbCompliance: inspectionStatus || 'NA'
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
      if (qualitycheck != null) entry.base.Qualitycheck = qualitycheck;
      if (certificateNo && !entry.rbCertificateNo) entry.rbCertificateNo = certificateNo;
      if (remarks) entry.base['Other Info'] = remarks;
      if (remarks) entry.inspectionRemarks = remarks;
      if (Object.keys(customFieldsRaw).length) {
        entry.base.customFields = {
          ...(entry.base.customFields || {}),
          ...customFieldsRaw
        };
      }
      if (schemaAssignmentsRaw.length) {
        entry.schemaAssignments = mergeImportedSchemaAssignments(entry.schemaAssignments || [], schemaAssignmentsRaw);
      }
      if (inspectionStatus && inspectionStatus !== 'NA') entry.rbCompliance = inspectionStatus;
      if (!entry.inspectionDate && inspectionDate) entry.inspectionDate = inspectionDate;
      if (entry.inspectionStatus === 'NA' && inspectionStatus !== 'NA') {
        entry.inspectionStatus = inspectionStatus;
      }
      if (inspectionType && (!entry.inspectionType || entry.inspectionType === 'Detailed')) {
        entry.inspectionType = inspectionType;
      }

      if (epl || equipmentGroup || equipmentCategory || environment || subGroup || tempClass || protectionConcept) {
        const autoMarking = buildMarkingString(protectionConcept, subGroup, tempClass);
        const inferredEnvironment = environment || determineEnvironmentFromSubGroup(subGroup);

        if (autoMarking && !entry.base.Marking) {
          entry.base.Marking = autoMarking;
        }

        const markingEntry = {
          'Equipment Protection Level': epl || '',
          'Equipment Group': equipmentGroup || '',
          'Equipment Category': equipmentCategory || '',
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
    if (parseErrors.length) {
      return res.status(400).json({
        message: 'The uploaded file contains invalid values.',
        issues: parseErrors
      });
    }
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
        payload.Unit = zone._id;
        payload.Site = zone.Site || null;
        if (entry.orderIndex != null) {
          payload.orderIndex = entry.orderIndex;
        }
        if (payload.customFields && Object.keys(payload.customFields).length) {
          payload.customFields = await sanitizeCustomFields({
            tenantId,
            entityType: 'equipment',
            values: payload.customFields
          });
        } else {
          delete payload.customFields;
        }
        const importedExMarkings = (payload['Ex Marking'] || []).filter(mark =>
          Object.values(mark).some(value => !!String(value || '').trim())
        );
        const rbValues = valuesFromEquipmentMarkings(importedExMarkings);
        rbValues.certificateNo = entry.rbCertificateNo || payload['Certificate No'] || '';
        rbValues.compliance = entry.rbCompliance || payload.Compliance || 'NA';
        delete payload['Ex Marking'];
        delete payload['Certificate No'];
        delete payload.Compliance;
        const hasRbValues =
          importedExMarkings.length ||
          String(rbValues.certificateNo || '').trim() ||
          String(rbValues.compliance || 'NA') !== 'NA';
        const rbSchema = hasRbValues ? await ensureRbSchema() : null;

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
            if (payload.customFields && Object.keys(payload.customFields).length) {
              const currentCustomFields = equipmentDoc.customFields instanceof Map
                ? Object.fromEntries(equipmentDoc.customFields.entries())
                : (equipmentDoc.customFields && typeof equipmentDoc.customFields === 'object' ? equipmentDoc.customFields : {});
              updateData.customFields = {
                ...currentCustomFields,
                ...payload.customFields
              };
            }
            delete updateData.CreatedBy;
            delete updateData.tenantId;
            if (rbSchema || entry.schemaAssignments?.length) {
              updateData.schemaAssignments = mergeImportedSchemaAssignments(
                Array.isArray(equipmentDoc.schemaAssignments) ? equipmentDoc.schemaAssignments : [],
                entry.schemaAssignments || []
              );
            }
            if (rbSchema) {
              ensureRbAssignment(updateData, rbSchema, rbValues, userId);
            }
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
          if (entry.schemaAssignments?.length) {
            createData.schemaAssignments = mergeImportedSchemaAssignments(createData.schemaAssignments || [], entry.schemaAssignments);
          }
          if (rbSchema) {
            ensureRbAssignment(createData, rbSchema, rbValues, userId);
          }
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
              entry.inspectionType || 'Detailed',
              entry.inspectionRemarks || ''
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

    if (includeProjectSkid) {
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
// A tényleges feldolgozás háttérjobként fut, hogy nagy (akár 2 GB) ZIP-eket is
// biztonságosan lehessen kezelni.

async function notifyEquipmentImportStatus(userId, {
  jobId,
  status,
  updatedEquipments = null,
  totalDocuments = null,
  issuesCount = null,
  errorMessage = null,
  processed = null,
  total = null,
  downloadUrl = null
} = {}) {
  if (!userId || !jobId || !status) return;

  let message;
  switch (status) {
    case 'queued':
      message = 'Equipment documents import queued.';
      break;
    case 'running':
      message = 'Equipment documents import is running...';
      break;
    case 'succeeded': {
      const parts = [];
      if (updatedEquipments != null) parts.push(`updated equipments: ${updatedEquipments}`);
      if (totalDocuments != null) parts.push(`documents imported: ${totalDocuments}`);
      if (issuesCount) parts.push(`issues: ${issuesCount}`);
      const suffix = parts.length ? ` (${parts.join(', ')})` : '';
      message = `Equipment documents import completed${suffix}.`;
      break;
    }
    case 'failed':
      message = `Equipment documents import failed${errorMessage ? `: ${errorMessage}` : '.'}`;
      break;
    default:
      message = `Equipment documents import status: ${status}.`;
  }

  const data = {
    jobId,
    jobType: 'equipment-docs-import',
    status
  };
  if (updatedEquipments != null) data.updatedEquipments = updatedEquipments;
  if (totalDocuments != null) data.totalDocuments = totalDocuments;
  if (issuesCount != null) data.issuesCount = issuesCount;
   // progress (processed/total) – hasonlóan az inspection export job-hoz
  if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
    data.progress = { processed, total };
  }
  if (downloadUrl) {
    data.downloadUrl = downloadUrl;
  }

  try {
    await notifyAndStore(userId, {
      type: 'equipment-docs-import',
      title: 'Equipment documents import',
      message,
      data,
      meta: { route: '/notifications', jobId }
    });
  } catch (err) {
    console.warn('⚠️ Failed to push equipment import status notification', err?.message || err);
  }
}

async function runEquipmentDocumentsZipImportJob({
  tenantId,
  userId,
  tenantName = '',
  zipPath,
  originalZipName,
  zoneObjectId,
  jobId
}) {
  if (!tenantId || !userId || !zipPath || !jobId) return;

  await notifyEquipmentImportStatus(userId, { jobId, status: 'running' });

  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) {
    await notifyEquipmentImportStatus(userId, {
      jobId,
      status: 'failed',
      errorMessage: 'Invalid tenantId.'
    });
    return;
  }

  const issues = [];
  const results = [];

  try {
    // 1) ZIP megnyitása
    const directory = await unzipper.Open.file(zipPath);
    const allEntries = directory.files.filter(f => f.type === 'File');

    if (!allEntries.length) {
      await notifyEquipmentImportStatus(userId, {
        jobId,
        status: 'failed',
        errorMessage: 'ZIP archive is empty.'
      });
      return;
    }

    // 2) XLSX fájl keresése – a ZIP neve alapján
    const zipBaseName = path.basename(originalZipName || '', path.extname(originalZipName || ''));
    let xlsxEntry = null;
    if (zipBaseName) {
      xlsxEntry =
        allEntries.find(e => {
          const base = path.basename(e.path, path.extname(e.path));
          return base.toLowerCase() === zipBaseName.toLowerCase();
        }) || null;
    }
    if (!xlsxEntry) {
      await notifyEquipmentImportStatus(userId, {
        jobId,
        status: 'failed',
        errorMessage: `No XLSX mapping file found in ZIP that matches the ZIP name ("${zipBaseName}.xlsx").`
      });
      return;
    }

    const xlsxBuffer = await xlsxEntry.buffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsxBuffer);
    const worksheet = workbook.worksheets?.[0];
    if (!worksheet) {
      await notifyEquipmentImportStatus(userId, {
        jobId,
        status: 'failed',
        errorMessage: 'The XLSX mapping file has no worksheet.'
      });
      return;
    }

    // 3) ZIP entry map a fájlnevekhez (relatív útvonal + basename)
    const entryByName = new Map();
    for (const entry of allEntries) {
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
        issues.push({
          row: rowNumber,
          column: 4,
          message: `File "${fileNameCell}" not found in ZIP.`
        });
        return;
      }

      const type = typeRaw === 'image' ? 'image' : 'document';
      const imageTag = type === 'image'
        ? normalizeImageTag(tagRawLower || 'general', 'general')
        : null;
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
      await notifyEquipmentImportStatus(userId, {
      jobId,
      status: 'failed',
      errorMessage: 'No valid rows found in XLSX mapping.'
      });
      return;
    }

    // Összes dokumentum számítása a progress-hez
    let totalPlannedDocuments = 0;
    for (const items of docsByEquipment.values()) {
      totalPlannedDocuments += Array.isArray(items) ? items.length : 0;
    }
    let processedDocuments = 0;
    if (totalPlannedDocuments > 0) {
      await notifyEquipmentImportStatus(userId, {
        jobId,
        status: 'running',
        processed: 0,
        total: totalPlannedDocuments
      });
    }

    const tenantNameSafe = tenantName || '';

    // 5) Fájlok feltöltése Azure Blobba és dokumentumok mentése equipmenthez
    const PROGRESS_STEP_COUNT = 10;
    const progressStep = totalPlannedDocuments > 0
      ? Math.max(1, Math.floor(totalPlannedDocuments / PROGRESS_STEP_COUNT))
      : 0;

    for (const [equipmentId, items] of docsByEquipment.entries()) {
      const eqFilter = { _id: equipmentId, tenantId: tenantObjectId };
      if (zoneObjectId) {
        Object.assign(eqFilter, { $or: [{ Unit: zoneObjectId }, { Zone: zoneObjectId }] });
      }

      const equipment = await Equipment.findOne(eqFilter);
      if (!equipment) {
        const baseMsg = `Equipment ${equipmentId} not found for this tenant${zoneObjectId ? ' or does not belong to this zone' : ''}. Skipping its rows.`;
        const relatedRows = Array.isArray(items) ? items.map(it => it.rowNumber).filter(Boolean) : [];
        if (relatedRows.length) {
          relatedRows.forEach(rowNumber => {
            issues.push({
              row: rowNumber,
              column: 1,
              message: baseMsg
            });
          });
        } else {
          issues.push({
            row: null,
            column: null,
            message: baseMsg
          });
        }
        continue;
      }

      const siteIdForPrefix = equipment.Site ? String(equipment.Site) : null;
      const unitIdForPrefix = equipment.Unit || equipment.Zone ? String(equipment.Unit || equipment.Zone) : null;
      const eqPrefix = buildEquipmentPrefix(
        tenantNameSafe,
        tenantId,
        siteIdForPrefix,
        unitIdForPrefix,
        equipment.EqID || equipment._id.toString()
      );

      const docs = [];
      for (const item of items) {
        try {
          const rawName = cleanFileName(path.posix.basename(item.fileName));
          const srcBuf = await item.entry.buffer();
          const inferredMime =
            mime.lookup(rawName) ||
            (item.type === 'image' ? 'image/jpeg' : 'application/octet-stream');

          const { buffer, name: convertedName, contentType } =
            await convertHeicBufferIfNeeded(srcBuf, rawName, inferredMime);

          const cleanName = convertedName;
          const aliasFromXlsx = (item.docAlias || '').trim();
          const blobPath = `${eqPrefix}/${cleanName}`;
          const guessedType = contentType || inferredMime;

          await azureBlob.uploadBuffer(blobPath, buffer, guessedType);

          docs.push({
            name: cleanName,
            alias: item.type === 'document' && aliasFromXlsx
              ? aliasFromXlsx
              : cleanName,
            type: item.type,
            blobPath,
            blobUrl: azureBlob.getBlobUrl(blobPath),
            contentType: guessedType,
            size: buffer.length,
            uploadedAt: new Date(),
            tag: item.type === 'image' ? item.imageTag : null
          });
        } catch (e) {
          issues.push({
            row: item.rowNumber || null,
            column: 4,
            message: `Equipment ${equipmentId}, file "${item.fileName}": ${e?.message || 'upload failed'}`
          });
        }

        // progress frissítés
        processedDocuments += 1;
        if (progressStep > 0 &&
          (processedDocuments === totalPlannedDocuments ||
            processedDocuments === 1 ||
            processedDocuments % progressStep === 0)
        ) {
          try {
            await notifyEquipmentImportStatus(userId, {
              jobId,
              status: 'running',
              processed: processedDocuments,
              total: totalPlannedDocuments
            });
          } catch (notifyErr) {
            console.warn('⚠️ Failed to push running status notification for equipment import', notifyErr?.message || notifyErr);
          }
        }
      }

      if (docs.length) {
        equipment.documents = [...(equipment.documents || []), ...docs];
        await equipment.save();
        results.push({ equipmentId: equipment._id.toString(), added: docs.length });
      }
    }

    const updatedEquipments = results.length;
    const totalDocuments = results.reduce((sum, r) => sum + (r.added || 0), 0);
    const issuesCount = issues.length;

    let errorReportDownloadUrl = null;
    if (issuesCount > 0) {
      try {
        const workbookOut = new ExcelJS.Workbook();
        await workbookOut.xlsx.load(xlsxBuffer);
        const worksheetOut = workbookOut.worksheets?.[0];

        if (worksheetOut) {
          const rowFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE5E5' } // halvány piros
          };
          const cellFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFF8080' } // sötétebb piros
          };

          const issuesByRow = new Map();
          issues.forEach(issue => {
            const rowNumber = issue.row;
            if (!rowNumber) return;
            if (!issuesByRow.has(rowNumber)) {
              issuesByRow.set(rowNumber, []);
            }
            issuesByRow.get(rowNumber).push(issue);
          });

          for (const [rowNumber, rowIssues] of issuesByRow.entries()) {
            const row = worksheetOut.getRow(rowNumber);
            row.eachCell(cell => {
              cell.fill = rowFill;
            });

            rowIssues.forEach(issue => {
              const colIndex = issue.column || 1;
              const cell = worksheetOut.getRow(rowNumber).getCell(colIndex);
              cell.fill = cellFill;
              const existingNote =
                typeof cell.note === 'string' && cell.note.length
                  ? `${cell.note}\n`
                  : '';
              cell.note = `${existingNote}${issue.message || 'Invalid data in this row.'}`;
            });
          }

          const summarySheet = workbookOut.addWorksheet('Import issues');
          summarySheet.addRow(['Updated equipments', updatedEquipments]);
          summarySheet.addRow(['Documents imported', totalDocuments]);
          summarySheet.addRow(['Issues', issuesCount]);
          summarySheet.getColumn(1).width = 24;
          summarySheet.getColumn(2).width = 12;

          const bufferOut = await workbookOut.xlsx.writeBuffer();
          const blobName = `equipment-docs-import-errors/${tenantId}/${jobId}.xlsx`;
          const blobPath = await azureBlob.uploadBuffer(
            blobName,
            Buffer.from(bufferOut),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          );
          try {
            errorReportDownloadUrl = await azureBlob.getReadSasUrl(blobPath, {
              ttlSeconds: Number(systemSettings.getNumber('EQUIP_DOCS_IMPORT_ERROR_XLS_TTL') || 24 * 60 * 60),
              filename: `equipment-documents-import-errors-${jobId}.xlsx`,
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
          } catch (sasErr) {
            console.warn('⚠️ Failed to build SAS URL for equipment-docs import errors XLSX', sasErr?.message || sasErr);
          }
        }
      } catch (excelErr) {
        console.warn(
          '⚠️ Failed to generate error XLSX for equipment docs import:',
          excelErr?.message || excelErr
        );
      }
    }

    await notifyEquipmentImportStatus(userId, {
      jobId,
      status: 'succeeded',
      updatedEquipments,
      totalDocuments,
      issuesCount,
      processed: totalPlannedDocuments || totalDocuments || null,
      total: totalPlannedDocuments || totalDocuments || null,
      downloadUrl: errorReportDownloadUrl || null
    });
  } catch (error) {
    console.error('❌ importEquipmentDocumentsZip background job error:', error);
    await notifyEquipmentImportStatus(userId, {
      jobId,
      status: 'failed',
      errorMessage: error.message || String(error)
    });
  } finally {
    if (zipPath) {
      try {
        fs.unlinkSync(zipPath);
      } catch (cleanupErr) {
        console.warn('⚠️ Failed to remove uploaded ZIP file:', cleanupErr?.message || cleanupErr);
      }
    }
  }
}

exports.importEquipmentDocumentsZip = async (req, res) => {
  const tenantId = req.scope?.tenantId;
  const userId = req.scope?.userId || req.userId;
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

  const jobId = `equipment-docs-import-${Date.now()}-${uuidv4().slice(0, 8)}`;

  // Kezdő "pending" / queued notification
  await notifyEquipmentImportStatus(userId, {
    jobId,
    status: 'queued'
  });

  const jobPayload = {
    tenantId,
    userId,
    tenantName: req.scope?.tenantName || '',
    zipPath: uploadedFile.path,
    originalZipName: uploadedFile.originalname || '',
    zoneObjectId,
    jobId
  };

  // Háttérben indul a feldolgozás, a kérés azonnal 202-vel visszatér
  setImmediate(() => {
    runEquipmentDocumentsZipImportJob(jobPayload).catch(err => {
      console.error('❌ Failed to start equipment documents import job:', err);
    });
  });

  return res.status(202).json({
    message: 'Equipment documents import queued.',
    jobId
  });
};

// Manuális cleanup endpoint: megszakított / elárvult feltöltési temp fájlok takarítására.
// Nem kap explicit uploadId-t, hanem a cleanupUploadTempFiles-t hívja azonnali (0 ms) küszöbbel,
// így csak a multer-temp és .zip fájlokat törli az uploads könyvtárból.
exports.cleanupTempUploadsNow = async (_req, res) => {
  try {
    // Csak a néhány perce (pl. 5 perc) nem módosított temp fájlokat töröljük,
    // így minimális az esélye, hogy éppen futó feltöltést érintenénk.
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    cleanupService.cleanupUploadTempFiles(FIVE_MINUTES_MS);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ cleanupTempUploadsNow error:', err);
    return res.status(500).json({ message: 'Failed to cleanup temp uploads.', error: err.message || String(err) });
  }
};

async function createAutoInspectionForImport(equipmentDoc, inspectionDate, inspectorId, tenantId, inspectionType = 'Detailed', remarks = '') {
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
  const basePassedTypes = new Set(['general', 'environment', 'additional checks', 'installation']);
  const relevantTypes = await getRelevantEquipmentTypesForDevice(
    equipmentDoc,
    tenantId
  ); // lowercased equipmentType-ok
  let results = [];

  if (questionDocs.length) {
    results = questionDocs.map((q) => {
      const eqType = (q.equipmentType || '').toLowerCase();
      const isAlwaysPassed = basePassedTypes.has(eqType) || eqType.startsWith('installation');
      const isRelevantByDevice = relevantTypes.has(eqType);

      return {
        questionId: q._id ? new mongoose.Types.ObjectId(q._id) : undefined,
        reference: deriveInspectionQuestionReference(q),
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
      reference: 'AUTO-1',
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
  results = results.map((r) => ({ ...r, reference: deriveInspectionQuestionReference(r) }));

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
    remarks: String(remarks || '').trim(),
    summary,
    status
  });

  await inspection.save();

  {
    const rbSchema = await ensureRbSchema();
    ensureRbAssignment(equipmentDoc, rbSchema, {
      ...getRbValues(equipmentDoc),
      compliance: status
    }, inspectorId);
    if (equipmentDoc.markModified) equipmentDoc.markModified('schemaAssignments');
  }
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
    const isIndexTenant = isIndexTenantSlug(tenantSlug);
    const isInspExDomain = isInspExRequestHost(req);
    const includeProjectSkid = isProjectSkidTenantSlug(tenantSlug) || isInspExDomain;
    const includeUserRequirement = !isInspExDomain;
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

    const customExportFields = await CustomFieldDefinition.find({
      tenantId,
      entityType: 'equipment',
      active: true,
      showInExport: true
    }).sort({ createdAt: 1, label: 1 }).lean();
    const customExportColumns = [
      ...customExportFields.map((field) => ({
        field,
        header: `Custom: ${field.label || field.key}`
      }))
    ];
    const schemaExportColumns = await loadEquipmentExportSchemaColumns(tenantId);
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
	      'Qualitycheck',
	      'EPL',
	      'Equipment Group',
	      'Equipment Category',
	      'Environment',
	      'SubGroup',
	      'Temperature Class',
	      'Protection Concept',
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

	    if (includeProjectSkid) {
	      const insertAt = headers.indexOf('Zone');
	      headers.splice(insertAt >= 0 ? insertAt : headers.length, 0, 'Skid ID', 'Skid Description', 'Project ID');
	    }

    if (!includeUserRequirement) {
      // Insp-Ex: keep IndEx-like layout but without USER REQUIREMENT columns.
      const toRemove = new Set([
        'Req Zone',
        'Req Gas / Dust Group',
        'Req Temp Rating',
        'Req Ambient Temp',
        'Req IP Rating'
      ]);
      for (let i = headers.length - 1; i >= 0; i--) {
        if (toRemove.has(headers[i])) headers.splice(i, 1);
      }
    }
    customExportColumns.forEach(({ header }) => headers.push(header));
    schemaExportColumns.forEach(({ header }) => headers.push(header));

    worksheet.columns = headers.map(header => ({
      header,
      key: header,
      width: 2
    }));

    // ➕ Extra csoportosító sor a fejléc fölé
    // Beszúrunk egy üres sort az első helyre, így az eredeti fejléc a 2. sorba csúszik.
    worksheet.spliceRows(1, 0, []);

	    const groupRow = worksheet.getRow(1);
	    const columnNumber = (header) => headers.indexOf(header) + 1;
	    const projectStartCol = includeProjectSkid ? columnNumber('Skid ID') : null;
	    const projectEndCol = includeProjectSkid ? columnNumber('Project ID') : null;
	    const zoneStartCol = columnNumber('Zone');
	    const zoneEndCol = columnNumber('Ambient Temp');
	    const userStartCol = includeUserRequirement ? columnNumber('Req Zone') : null;
	    const userEndCol = includeUserRequirement ? columnNumber('Req IP Rating') : null;
	    const inspectionStartCol = columnNumber('Inspection Date');
	    const inspectionEndCol = columnNumber('Remarks');
	    const customStartCol = customExportColumns.length ? columnNumber(customExportColumns[0].header) : 0;
	    const customEndCol = customStartCol ? customStartCol + customExportColumns.length - 1 : 0;
	    const schemaStartCol = schemaExportColumns.length ? columnNumber(schemaExportColumns[0].header) : 0;
	    const schemaEndCol = schemaStartCol ? schemaStartCol + schemaExportColumns.length - 1 : 0;

    groupRow.getCell(1).value = 'IDENTIFICATION';
    worksheet.mergeCells(1, 1, 1, 4);
	    groupRow.getCell(5).value = 'EQUIPMENT DATA';
	    worksheet.mergeCells(1, 5, 1, 10);
	    groupRow.getCell(11).value = 'EX DATA';
	    worksheet.mergeCells(1, 11, 1, 18);
	    groupRow.getCell(19).value = 'CERTIFICATION';
	    worksheet.mergeCells(1, 19, 1, 22);
	    if (includeProjectSkid) {
	      groupRow.getCell(projectStartCol).value = 'PROJECT / SKID';
	      worksheet.mergeCells(1, projectStartCol, 1, projectEndCol);
	    }
    groupRow.getCell(zoneStartCol).value = 'ZONE REQUIREMENTS';
    worksheet.mergeCells(1, zoneStartCol, 1, zoneEndCol);
    if (includeUserRequirement) {
      groupRow.getCell(userStartCol).value = 'USER REQUIREMENT';
      worksheet.mergeCells(1, userStartCol, 1, userEndCol);
    }
    groupRow.getCell(inspectionStartCol).value = 'INSPECTION DATA';
    worksheet.mergeCells(1, inspectionStartCol, 1, inspectionEndCol);
	    if (customStartCol && customEndCol) {
	      groupRow.getCell(customStartCol).value = 'CUSTOM DATA';
	      if (customEndCol > customStartCol) {
	        worksheet.mergeCells(1, customStartCol, 1, customEndCol);
	      }
	    }
	    if (schemaStartCol && schemaEndCol) {
	      groupRow.getCell(schemaStartCol).value = 'SCHEMA DATA';
	      if (schemaEndCol > schemaStartCol) {
	        worksheet.mergeCells(1, schemaStartCol, 1, schemaEndCol);
	      }
	    }

	    const groupColorRanges = [
	      { start: 1, end: 4, color: 'FF00AA00' },
	      { start: 5, end: 10, color: 'FFFF9900' },
	      { start: 11, end: 18, color: 'FF538DD5' },
	      { start: 19, end: 22, color: 'FF00AA00' }
	    ];
	    if (includeProjectSkid) {
	      groupColorRanges.push({ start: projectStartCol, end: projectEndCol, color: 'FF80DEEA' });
	    }
    groupColorRanges.push(
      { start: zoneStartCol, end: zoneEndCol, color: 'FFFFFF66' },
      { start: inspectionStartCol, end: inspectionEndCol, color: 'FFB0B0B0' }
    );
    if (customStartCol && customEndCol) {
      groupColorRanges.push({ start: customStartCol, end: customEndCol, color: 'FFD9EAD3' });
    }
    if (schemaStartCol && schemaEndCol) {
      groupColorRanges.push({ start: schemaStartCol, end: schemaEndCol, color: 'FF8E7CC3' });
    }
    if (includeUserRequirement) {
      groupColorRanges.splice(groupColorRanges.length - 1, 0, {
        start: userStartCol,
        end: userEndCol,
        color: 'FFB1A0C7'
      });
    }

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
	      { start: 5, end: 10, color: 'FFFFE0B2' },
	      { start: 11, end: 18, color: 'FFDCE6F1' },
	      { start: 19, end: 22, color: 'FFCCFFCC' }
	    ];
	    if (includeProjectSkid) {
	      headerColorRanges.push({ start: projectStartCol, end: projectEndCol, color: 'FFE0F7FA' });
	    }
    headerColorRanges.push(
      { start: zoneStartCol, end: zoneEndCol, color: 'FFFFFFCC' },
      { start: inspectionStartCol, end: inspectionEndCol, color: 'FFE0E0E0' }
    );
    if (customStartCol && customEndCol) {
      headerColorRanges.push({ start: customStartCol, end: customEndCol, color: 'FFEAF4E4' });
    }
    if (schemaStartCol && schemaEndCol) {
      headerColorRanges.push({ start: schemaStartCol, end: schemaEndCol, color: 'FFEADCF8' });
    }
    if (includeUserRequirement) {
      headerColorRanges.splice(headerColorRanges.length - 1, 0, {
        start: userStartCol,
        end: userEndCol,
        color: 'FFE4DFEC'
      });
    }

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
	      'Qualitycheck',
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
      'Status'
    ]);
    if (includeUserRequirement) {
      centerAlignedColumns.add('Req Zone');
      centerAlignedColumns.add('Req Gas / Dust Group');
      centerAlignedColumns.add('Req Temp Rating');
      centerAlignedColumns.add('Req Ambient Temp');
      centerAlignedColumns.add('Req IP Rating');
    }

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

      const zoneDisplays = zoneRbDisplays(zone);
      const zoneNumber = zoneDisplays.zoneNumber;
      const zoneSubGroup = zoneDisplays.subGroup;
      const zoneTempDisplay = zoneDisplays.temp;
      const ambientDisplay = zoneDisplays.ambient;

      let clientReqZoneNumber = '';
      let clientReqGasDustGroup = '';
      let clientReqTempDisplay = '';
      let clientReqAmbientDisplay = '';
      if (includeUserRequirement) {
        const req = clientReqDisplays(zoneDisplays.clientReq[0]);
        clientReqZoneNumber = req.zone;
        clientReqGasDustGroup = req.subGroup;
        clientReqTempDisplay = req.temp;
        clientReqAmbientDisplay = req.ambient;
      }

      const cert = resolveCertificateFromCache(certMap, certificateNo(eq));
      const hasSpecialCondition =
        !!(cert && (cert.specCondition || cert.xcondition));

      // Certificate vs Declaration of conformity megjelenítés
      const rawCertNo = certificateNo(eq) || '';
      let exportCertNo = rawCertNo;
      let exportDocNo = '';

      if (cert && cert.docType === 'manufacturer_declaration') {
        exportCertNo = '';
        exportDocNo = rawCertNo;
      }

      const exMarkings = equipmentMarkings(eq).length ? equipmentMarkings(eq) : [null];

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
          'Qualitycheck': eq.Qualitycheck ? 'Yes' : 'No',
          'EPL': marking ? marking['Equipment Protection Level'] || '' : '',
          'Equipment Group': marking ? marking['Equipment Group'] || '' : '',
          'Equipment Category': marking ? marking['Equipment Category'] || '' : '',
          'Environment': marking ? marking.Environment || '' : '',
          'SubGroup': marking ? marking['Gas / Dust Group'] || '' : '',
          'Temperature Class': marking ? marking['Temperature Class'] || '' : '',
          'Protection Concept': marking ? marking['Type of Protection'] || '' : '',
          'Certificate No': exportCertNo,
          'Certificate Issue Date': cert?.issueDate || '',
          'Special Condition': hasSpecialCondition ? 'Yes' : 'No',
          'Declaration of conformity': exportDocNo,
          'Zone': zoneNumber,
          'Gas / Dust Group': zoneSubGroup,
          'Temp Rating': zoneTempDisplay,
          'Ambient Temp': ambientDisplay,
          'Status': complianceStatus(eq) || '',
          'Inspection Date': inspectionDate
            ? new Date(inspectionDate)
            : '',
          'Inspector': inspectorName,
          'Type': displayInspectionTypeForReport(inspection?.inspectionType),
          'Remarks': eq['Other Info'] || ''
        };

        if (includeUserRequirement) {
          rowData['Req Zone'] = clientReqZoneNumber;
          rowData['Req Gas / Dust Group'] = clientReqGasDustGroup;
          rowData['Req Temp Rating'] = clientReqTempDisplay;
          rowData['Req Ambient Temp'] = clientReqAmbientDisplay;
          rowData['Req IP Rating'] = '';
        }

        if (includeProjectSkid) {
          rowData['Skid ID'] = zone?.SkidID || '';
          rowData['Skid Description'] = zone?.SkidDescription || '';
          rowData['Project ID'] = zone?.ProjectID || '';
        }

        customExportColumns.forEach(({ field, header }) => {
          rowData[header] = customFieldValue(eq.customFields, field.key);
        });
        appendSchemaExportValues(rowData, eq, schemaExportColumns);

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

    if (searchTerm && searchTerm.length >= 2) {
      const regex = new RegExp(`^${escapeRegex(searchTerm)}`, 'i');
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

    const customExportFields = await CustomFieldDefinition.find({
      tenantId,
      entityType: 'equipment',
      active: true,
      showInExport: true
    }).sort({ createdAt: 1, label: 1 }).lean();
    const customExportColumns = [
      ...customExportFields.map((field) => ({
        field,
        header: `Custom: ${field.label || field.key}`
      }))
	    ];
    const schemaExportColumns = await loadEquipmentExportSchemaColumns(tenantId);

	    let hideAtexSpecific = false;
    if (typeof scheme === 'string' && scheme.toUpperCase() === 'IECEX') {
      hideAtexSpecific = true;
    } else if (zoneId) {
      const zoneDoc = await Zone.findOne({ _id: zoneId, tenantId }).lean();
      hideAtexSpecific = (zoneView(zoneDoc).Scheme || '').toUpperCase() === 'IECEX';
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Database');

    const headers = [
      '_id',
      'EqID',
      'TagNo',
      'Manufacturer',
      'Model/Type',
      'Serial Number',
	      'Equipment Type',
	      'Marking',
	      'Equipment Group',
	      'Equipment Category',
	      'Environment',
      'Type of Protection',
      'Gas / Dust Group',
      'Temperature Class',
      'Equipment Protection Level',
      'IP rating',
	      'Certificate No',
	      'Max Ambient Temp',
	      'Qualitycheck',
	      'Compliance',
	      'Other Info',
	      ...customExportColumns.map((c) => c.header),
	      ...schemaExportColumns.map((c) => c.header)
	    ];

	    const exportColumns = buildEquipmentListExportColumns(headers);
	    worksheet.columns = exportColumns.map(column => ({
	      header: column.header,
	      key: column.header,
	      width: column.width
	    }));
	    worksheet.spliceRows(1, 0, []);
	    applyEquipmentExportHeaderStyles(worksheet, exportColumns);

	    const centerAlignedColumns = [
	      'Equipment Group',
	      'Equipment Category',
	      'Environment',
	      'Qualitycheck',
      'Type of Protection',
      'Gas / Dust Group',
      'Temperature Class',
      'Equipment Protection Level',
      'IP rating'
    ];

    const buildRowBase = (item) => ({
      '_id': item?._id ? item._id.toString() : '',
      'EqID': item?.EqID || '',
      'TagNo': item?.TagNo || '',
      'Manufacturer': item?.Manufacturer || '',
      'Model/Type': item?.['Model/Type'] || '',
      'Serial Number': item?.['Serial Number'] || '',
      'Equipment Type': item?.['Equipment Type'] || '',
	      'Certificate No': certificateNo(item) || '',
	      'Max Ambient Temp': item?.['Max Ambient Temp'] || '',
	      'Qualitycheck': item?.Qualitycheck ? 'Yes' : 'No',
	      'Compliance': complianceStatus(item) || '',
	      'Other Info': item?.['Other Info'] || '',
	      'IP rating': item?.['IP rating'] || '',
      ...customExportColumns.reduce((acc, { field, header }) => {
        acc[header] = customFieldValue(item?.customFields, field.key);
        return acc;
      }, {})
    });

    const rows = [];
    equipments.forEach(item => {
      const baseRow = appendSchemaExportValues(buildRowBase(item), item, schemaExportColumns);
      const exMarkings = equipmentMarkings(item);
      if (!exMarkings.length) {
        rows.push({
          ...baseRow,
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
            ...baseRow,
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
      const rawCert = typeof certificateNo(eq) === 'string'
        ? certificateNo(eq).trim()
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
        const marking = primaryEquipmentMarking(eq);
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
          eq['IP rating'] || '',
          eq.lastInspectionStatus || complianceStatus(eq) || ''
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
      const rawCert = typeof certificateNo(eq) === 'string'
        ? certificateNo(eq).trim()
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
          eq['IP rating'] || '';
        if (!ipRating && ip) {
          ipRating = ip;
        }

        const markingArr = equipmentMarkings(eq).length ? equipmentMarkings(eq) : null;

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

    // Backfill computed defaults for older docs where the field doesn't exist yet.
    if (!equipment.operationalStatus) equipment.operationalStatus = 'operating';
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

    if (req.query.updatedSince) {
      const raw = String(req.query.updatedSince).trim();
      const asNum = Number(raw);
      const d = Number.isFinite(asNum) ? new Date(asNum) : new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        filter.updatedAt = { $gt: d };
      }
    }

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

    if (req.query.Qualitycheck !== undefined) {
      const raw = String(req.query.Qualitycheck).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(raw)) filter.Qualitycheck = true;
      else if (['false', '0', 'no'].includes(raw)) filter.Qualitycheck = false;
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

    // Hide mobile-created equipment until async processing is finished.
    // Can be overridden with ?includeUnprocessed=true
    const includeUnprocessed = String(req.query.includeUnprocessed || 'false').toLowerCase() === 'true';
    if (!includeUnprocessed) {
      // Include legacy docs where the field doesn't exist yet (MongoDB doesn't match missing fields on {isProcessed: true}).
      filter.isProcessed = { $ne: false };
    }

    const requestedSortField = typeof req.query.sortBy === 'string' && req.query.sortBy.trim()
      ? req.query.sortBy.trim()
      : 'orderIndex';
    const sortField = EQUIPMENT_LIST_SORT_FIELDS.has(requestedSortField) ? requestedSortField : 'orderIndex';
    const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
    const sortOptions = { [sortField]: sortDir, _id: 1 };

    const rawPageSize = parseInt(req.query.pageSize || req.query.limit, 10);
    const usePagination = true;
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.min(Math.max(rawPageSize, 1), 200)
      : 100;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skipParam = parseInt(req.query.skip, 10);
    const skip = Number.isFinite(skipParam) && skipParam >= 0 ? skipParam : (page - 1) * pageSize;
    const keyset = buildEquipmentKeysetMatch({
      sortField,
      sortDir,
      afterValue: req.query.afterValue,
      afterId: req.query.afterId
    });
    if (keyset) {
      if (filter.$and) filter.$and.push(keyset);
      else filter.$and = [keyset];
    }

    const includeTotal = String(req.query.includeTotal ?? 'true').toLowerCase() !== 'false';
    const effectiveLimit = includeTotal ? pageSize : pageSize + 1;

    const query = Equipment.find(filter)
      .select(EQUIPMENT_LIST_SELECT)
      .sort(sortOptions)
      .skip(keyset ? 0 : (skip || 0))
      .limit(effectiveLimit)
      .maxTimeMS(maxTimeMsFromEnv('EQUIPMENT_QUERY_MAX_TIME_MS', 10_000));

    const [rawEquipments, totalCount] = await Promise.all([
      query.lean(),
      includeTotal ? Equipment.countDocuments(filter) : Promise.resolve(null)
    ]);
    const hasNext = !includeTotal && rawEquipments.length > pageSize;
    const equipments = includeTotal ? rawEquipments : rawEquipments.slice(0, pageSize);

    let certMap = new Map();
    try {
      certMap = await buildCertificateCacheForCertNos(tenantId, equipments.map(eq => certificateNo(eq)).filter(Boolean));
    } catch (e) {
      console.warn('⚠️ Certificate cache build failed for listEquipment:', e?.message || e);
      certMap = new Map();
    }

    const withPaths = equipments.map(eq => {
      const operationalStatus = eq.operationalStatus || 'operating';
      const firstBlobUrl =
        eq.Pictures?.find?.(p => p.blobUrl)?.blobUrl ||
        eq.documents?.find?.(d => (d.type === 'image' || d.type === undefined) && d.blobUrl)?.blobUrl ||
        null;
      const certDoc = resolveCertificateFromCache(certMap, certificateNo(eq));

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
        operationalStatus,
        'Ex Marking': equipmentMarkings(eq),
        'Certificate No': certificateNo(eq) || '',
        Compliance: complianceStatus(eq) || 'NA',
        'IP rating': eq['IP rating'] || '',
        IP: eq['IP rating'] || '',
        ipRating: eq['IP rating'] || '',
        BlobPreviewUrl: firstBlobUrl,
        'X condition': xCondition,
        _linkedCertificate: linkedCertificate,
        certificateDocType: linkedCertificate?.docType || 'unknown'
      };
    });

    return res.json({
      items: withPaths,
      total: typeof totalCount === 'number' ? totalCount : skip + withPaths.length + (hasNext ? 1 : 0),
      hasNext,
      nextCursor: buildEquipmentNextCursor(equipments, sortField),
      page,
      pageSize
    });
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
    const oldSnapshotForVersioning = equipment.toObject({ depopulate: true });

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
    if (Object.prototype.hasOwnProperty.call(updatedFields, 'customFields')) {
      updatedFields.customFields = await sanitizeCustomFields({
        tenantId,
        entityType: 'equipment',
        values: updatedFields.customFields
      });
    }
    if (Object.prototype.hasOwnProperty.call(updatedFields, 'schemaAssignments')) {
      updatedFields.schemaAssignments = await sanitizeEquipmentSchemaAssignmentsForSave(updatedFields.schemaAssignments, tenantId);
      updatedFields.schemaAssignments = preserveRbComplianceForEquipmentUpdate(updatedFields.schemaAssignments, equipment);
    }
    delete updatedFields.Compliance;
    delete updatedFields.lastInspectionDate;
    delete updatedFields.lastInspectionValidUntil;
    delete updatedFields.lastInspectionStatus;
    delete updatedFields.lastInspectionId;
    updatedFields.ModifiedBy = new mongoose.Types.ObjectId(ModifiedBy);

    const updatedEquipment = await Equipment.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    );

    try {
      await createEquipmentDataVersion({
        tenantId,
        equipmentId: id,
        changedBy: ModifiedBy,
        source: 'update',
        oldSnapshot: oldSnapshotForVersioning,
        newSnapshot: updatedEquipment?.toObject?.({ depopulate: true }) || updatedEquipment
      });
    } catch (versionErr) {
      try {
        console.warn('⚠️ Failed to write equipment data version:', versionErr?.message || versionErr);
      } catch {}
    }

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
        const oldPrefix = buildEquipmentPrefix(
          tenantName,
          req.scope?.tenantId,
          oldSiteId ? String(oldSiteId) : null,
          oldZoneId ? String(oldZoneId) : null,
          oldEqID
        );
        const newPrefix = buildEquipmentPrefix(
          tenantName,
          req.scope?.tenantId,
          newSiteId ? String(newSiteId) : null,
          newZoneId ? String(newZoneId) : null,
          updatedEquipment.EqID
        );

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
      const siteIdForPrefix = updatedEquipment.Site ? String(updatedEquipment.Site) : null;
      const unitIdForPrefix = updatedEquipment.Unit || updatedEquipment.Zone ? String(updatedEquipment.Unit || updatedEquipment.Zone) : null;
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteIdForPrefix, unitIdForPrefix, updatedEquipment.EqID);
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

// --- Equipment data versioning (SCD2-like) ---
// GET /exreg/:id/versions
exports.listEquipmentDataVersions = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId' });

    const equipment = await Equipment.findOne({ _id: id, tenantId }).select('_id').lean();
    if (!equipment) return res.status(404).json({ message: 'Equipment not found' });

    const versions = await EquipmentDataVersion.find({ tenantId, equipmentId: id })
      .sort({ changedAt: -1, version: -1 })
      .select('version changedAt changedBy source changedPaths previousVersionId')
      .populate('changedBy', 'firstName lastName email')
      .lean();

    return res.json(versions || []);
  } catch (err) {
    console.error('❌ listEquipmentDataVersions error:', err);
    return res.status(500).json({ message: 'Failed to load equipment data versions.' });
  }
};

// GET /exreg/:id/versions/:versionId
exports.getEquipmentDataVersion = async (req, res) => {
  try {
    const { id, versionId } = req.params;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId' });

    const equipment = await Equipment.findOne({ _id: id, tenantId }).select('_id').lean();
    if (!equipment) return res.status(404).json({ message: 'Equipment not found' });

    const versionDoc = await EquipmentDataVersion.findOne({
      _id: versionId,
      tenantId,
      equipmentId: id
    })
      .populate('changedBy', 'firstName lastName email')
      .lean();

    if (!versionDoc) return res.status(404).json({ message: 'Version not found' });

    const previous = versionDoc.previousVersionId
      ? await EquipmentDataVersion.findOne({
          _id: versionDoc.previousVersionId,
          tenantId,
          equipmentId: id
        })
          .select('snapshot version changedAt')
          .lean()
      : null;

    return res.json({
      version: versionDoc,
      previousVersion: previous
    });
  } catch (err) {
    console.error('❌ getEquipmentDataVersion error:', err);
    return res.status(500).json({ message: 'Failed to load equipment data version.' });
  }
};

// Törlés (DELETE /exreg/:id)
async function deleteEquipmentInternal(equipment, tenantId, tenantName) {
  const siteIdForPrefix = equipment.Site ? String(equipment.Site) : null;
  const unitIdForPrefix = equipment.Unit || equipment.Zone ? String(equipment.Unit || equipment.Zone) : null;
  const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteIdForPrefix, unitIdForPrefix, equipment.EqID);
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
  scheduleDashboardStatsDirty({ tenantId, reason: 'equipment_deleted' });

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

    try {
      await recordTombstone({
        tenantId,
        entityType: 'equipment',
        entityId: equipment._id,
        deletedBy: req.userId || null,
        meta: { siteId: equipment.Site || null, zoneId: equipment.Zone || null, EqID: equipment.EqID || '' }
      });
    } catch (e) {
      console.warn('⚠️ Failed to write equipment tombstone:', e?.message || e);
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

    try {
      await Promise.all(
        equipments.map((equipment) =>
          recordTombstone({
            tenantId,
            entityType: 'equipment',
            entityId: equipment._id,
            deletedBy: req.userId || null,
            meta: { siteId: equipment.Site || null, zoneId: equipment.Zone || null, EqID: equipment.EqID || '' }
          }).catch(() => {})
        )
      );
    } catch {}

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
