// controllers/exportInspectionReport.js

const ExcelJS = require('exceljs');
const archiver = require('archiver');
const path = require('path');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Inspection = require('../models/inspection');
const Dataplate = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const Unit = require('../models/unit');
const Certificate = require('../models/certificate');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const ReportExportJob = require('../models/reportExportJob');
const azureBlob = require('../services/azureBlobService');
const sharp = require('sharp');
const https = require('https');
const mailService = require('../services/mailService');
const mailTemplates = require('../services/mailTemplates');
const { notifyAndStore } = require('../lib/notifications/notifier');
const {
  buildCertificateCacheForCertNos,
  resolveCertificateFromCache
} = require('../helpers/certificateMatchHelper');
const { certificateNo, complianceStatus, getRbValues } = require('../services/rbSchemaValueService');
const systemSettings = require('../services/systemSettingsStore');
const {
  equipmentMarkings,
  primaryEquipmentMarking,
  zoneView
} = require('../services/rbSchemaValueService');
const { convertXlsxBufferToPdfBuffer } = require('../services/xlsxPdfService');

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_CONTENT_TYPE = 'application/pdf';
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

const INDEX_LOGO_URL = 'https://certs.atexdb.eu/public/voith-logo.png' //'https://certs.atexdb.eu/public/index_logo.png';
const REPORT_JOB_TYPES = {
  PROJECT_FULL: 'project_full',
  LATEST_INSPECTIONS: 'latest_inspections'
};
const REPORT_BLOB_PREFIX = 'report-exports';
const PRINTABLE_PAGE_HEIGHT_POINTS = 720;
function displayInspectionTypeForReport(type) {
  return String(type || '') === 'Initial Detailed (Index)' ? 'Initial Detailed' : (type || '');
}

function displayInspectionTypeForHeader(inspection) {
  if (!inspection) return '';
  if (inspection.schemaNameSnapshot && String(inspection.inspectionType || '') === 'Criteria') {
    return String(inspection.schemaNameSnapshot || '').trim();
  }
  return String(displayInspectionTypeForReport(inspection.inspectionType) || '').trim();
}

async function getTenantReportLogoUrl(tenantId) {
  if (!tenantId) return '';
  try {
    const tenant = await Tenant.findById(tenantId).select('logoBlobUrl logoBlobPath').lean();
    return tenant?.logoBlobUrl || (tenant?.logoBlobPath ? azureBlob.getBlobUrl(tenant.logoBlobPath) : '') || '';
  } catch (err) {
    console.warn('⚠️ Failed to load tenant report logo:', err?.message || err);
    return '';
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
  if (rb.MaxTemp !== '' && rb.MaxTemp !== null && rb.MaxTemp !== undefined) tempParts.push(`${rb.MaxTemp}°C`);
  const ambientParts = [];
  if (rb.AmbientTempMin !== null && rb.AmbientTempMin !== undefined) ambientParts.push(`${rb.AmbientTempMin}°C`);
  if (rb.AmbientTempMax !== null && rb.AmbientTempMax !== undefined) ambientParts.push(`+${rb.AmbientTempMax}°C`);
  return {
    ...rb,
    zoneNumber: listDisplay(rb.Zone),
    subGroup: listDisplay(rb.SubGroup),
    temp: tempParts.join(' / '),
    ambient: ambientParts.join(' - '),
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

function getReportExportRetentionDays() {
  const n = Number(systemSettings.getNumber('REPORT_EXPORT_RETENTION_DAYS'));
  return Number.isFinite(n) && n > 0 ? n : 7;
}
const PROJECT_REPORT_DIRS = {
  INSPECTIONS: 'Inspection Reports',
  IMAGES: 'Images',
  DOCUMENTS: 'Documents',
  CERTIFICATES: 'Certificates'
};
const REPORT_PROGRESS_STEP_COUNT = 10;

const REPORT_EQUIPMENT_FIELDS = [
  'EqID',
  'TagNo',
  'Manufacturer',
  'Model/Type',
  'Serial Number',
  'Equipment Type',
  'IP rating',
  'Max Ambient Temp',
  'Other Info',
  'Site',
  'Zone',
  'Unit',
  'orderIndex',
  'Pictures',
  'documents',
  'X condition',
  'schemaAssignments',
  'lastInspectionId',
  'lastInspectionDate',
  'lastInspectionValidUntil',
  'lastInspectionStatus',
  'CertificateNo',
  'certificateNo',
  'Declaration of conformity',
  'CertNo',
  'certNo',
  'certificateNumber',
  'Ex Marking',
  'customFields'
];
const REPORT_EQUIPMENT_SELECT = Object.fromEntries(
  REPORT_EQUIPMENT_FIELDS.map(field => [field, 1])
);

const REPORT_INSPECTOR_SELECT = 'firstName lastName name position positionInfo signatureBlobUrl signatureBlobPath email';

function applyOnePageWidePrintSetup(ws) {
  ws.pageSetup = ws.pageSetup || {};
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;
  ws.pageSetup.horizontalCentered = true;
  ws.pageSetup.verticalCentered = false;
  ws.pageSetup.margins = {
    left: 0.25,
    right: 0.25,
    top: 0.3,
    bottom: 0.3,
    header: 0,
    footer: 0
  };
  ws.pageSetup.printArea = 'A:N';
}

function rowHeightPoints(row) {
  const h = Number(row?.height || 0);
  return Number.isFinite(h) && h > 0 ? h : 15;
}

function getCurrentPrintPageHeight(ws, pageHeight = PRINTABLE_PAGE_HEIGHT_POINTS) {
  let current = 0;
  for (let rn = 1; rn <= ws.rowCount; rn += 1) {
    const row = ws.getRow(rn);
    current += rowHeightPoints(row);
    if (row?.model?.pageBreak || row?.pageBreak) {
      current = 0;
      continue;
    }
    if (current > pageHeight) {
      current = rowHeightPoints(row);
    }
  }
  return current;
}

function addPageBreakBeforeNextRow(ws) {
  const lastRow = ws.lastRow;
  if (!lastRow) return false;
  if (typeof lastRow.addPageBreak === 'function') {
    lastRow.addPageBreak();
  } else {
    lastRow.pageBreak = true;
  }
  return true;
}

function ensureNextBlockFitsOnPage(ws, requiredHeight, pageHeight = PRINTABLE_PAGE_HEIGHT_POINTS) {
  const required = Number(requiredHeight || 0);
  if (!Number.isFinite(required) || required <= 0 || required >= pageHeight) return false;
  const current = getCurrentPrintPageHeight(ws, pageHeight);
  if (current > 0 && current + required > pageHeight) {
    return addPageBreakBeforeNextRow(ws);
  }
  return false;
}

function normalizeInspectionExportFormat(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return value === 'pdf' ? 'pdf' : 'xlsx';
}

function replaceFileExtension(fileName, extension) {
  const ext = String(extension || '').startsWith('.') ? extension : `.${extension || 'bin'}`;
  return String(fileName || 'report.xlsx').replace(/\.[^.]+$/i, '') + ext;
}

async function buildInspectionFileBuffer(workbook, fileName, format = 'xlsx') {
  const normalizedFormat = normalizeInspectionExportFormat(format);
  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  if (normalizedFormat !== 'pdf') {
    return {
      buffer: xlsxBuffer,
      fileName,
      contentType: EXCEL_CONTENT_TYPE
    };
  }

  const pdfFileName = replaceFileExtension(fileName, '.pdf');
  const pdfBuffer = await convertXlsxBufferToPdfBuffer(Buffer.from(xlsxBuffer), { fileName });
  return {
    buffer: pdfBuffer,
    fileName: pdfFileName,
    contentType: PDF_CONTENT_TYPE
  };
}

function normalizeInspectionSeverity(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return ['P1', 'P2', 'P3', 'P4'].includes(normalized) ? normalized : null;
}

function buildNoteCellValueWithSeverity(note, severity) {
  const normalizedSeverity = normalizeInspectionSeverity(severity);
  const noteText = (note || '').toString();

  if (!normalizedSeverity) {
    return { value: noteText, text: noteText };
  }

  if (!noteText) {
    return {
      value: {
        richText: [
          { text: 'Severity: ' },
          { text: normalizedSeverity, font: { bold: true } }
        ]
      },
      text: `Severity: ${normalizedSeverity}`
    };
  }

  return {
    value: {
      richText: [
        { text: `${noteText} - Severity: ` },
        { text: normalizedSeverity, font: { bold: true } }
      ]
    },
    text: `${noteText} - Severity: ${normalizedSeverity}`
  };
}

function buildCommentCellValueWithSeverity(note, severity, imageNames = []) {
  const safeImageNames = Array.isArray(imageNames) ? imageNames.filter(Boolean) : [];
  const imagesLine = safeImageNames.length ? `Images: ${safeImageNames.join(', ')}` : '';
  const normalizedSeverity = normalizeInspectionSeverity(severity);

  if (!normalizedSeverity) {
    const baseComment = (note || '').toString();
    const text = imagesLine ? (baseComment ? `${baseComment}\n${imagesLine}` : imagesLine) : baseComment;
    return { value: text, text };
  }

  const base = buildNoteCellValueWithSeverity(note, normalizedSeverity);
  if (!imagesLine) return base;

  const suffix = `\n${imagesLine}`;
  if (base.value && typeof base.value === 'object' && Array.isArray(base.value.richText)) {
    base.value.richText.push({ text: suffix });
  }
  return { value: base.value, text: `${base.text}${suffix}` };
}

function buildExportJobContext(job = {}) {
  return (
    job?.meta?.siteName ||
    job?.meta?.zoneName ||
    job?.meta?.downloadName ||
    job?.params?.siteId ||
    job?.params?.zoneId ||
    'Inspection export'
  );
}

function createProgressCallback(job) {
  const label = `[report-job ${job?.jobId || 'unknown'}]`;
  let lastNotified = -1;
  let lastPersistedAt = 0;
  return ({ processed = 0, total = 0 } = {}) => {
    if (!(typeof processed === 'number' && typeof total === 'number' && total > 0)) {
      console.info(`${label} progress update`);
      return;
    }
    const step = Math.max(1, Math.floor(total / REPORT_PROGRESS_STEP_COUNT));
    const shouldNotify =
      processed === 0 ||
      processed === total ||
      processed - lastNotified >= step;
    if (!shouldNotify) return;
    lastNotified = processed;
    console.info(`${label} progress ${processed}/${total}`);
    const now = Date.now();
    if (job?.jobId && (processed === 0 || processed === total || now - lastPersistedAt >= 5000)) {
      lastPersistedAt = now;
      ReportExportJob.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            progress: { processed, total, updatedAt: new Date() },
            lastHeartbeatAt: new Date()
          }
        }
      ).catch(err => {
        console.warn('⚠️ Failed to persist export job progress', err?.message || err);
      });
    }
    if (job?.userId) {
      notifyExportJobStatus(job, { status: 'running', processed, total }).catch(err => {
        console.warn('⚠️ Failed to push running status notification', err?.message || err);
      });
    }
  };
}

function errorDetails(err) {
  if (!err) return { message: 'Unknown error' };
  return {
    message: err?.message || String(err),
    name: err?.name || undefined,
    code: err?.code || undefined,
    stack: err?.stack || undefined
  };
}

async function notifyExportJobStatus(job, { status, processed = null, total = null, downloadUrl = null } = {}) {
  if (!job?.userId) return;
  const messageContext = buildExportJobContext(job);
  let message;
  switch ((status || '').toLowerCase()) {
    case 'queued':
      message = `${messageContext} export queued.`;
      break;
    case 'running': {
      if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
        message = `Processing ${messageContext}: ${processed}/${total} equipment...`;
      } else {
        message = `${messageContext} export is running...`;
      }
      break;
    }
    case 'succeeded':
      message = `${messageContext} export is ready to download.`;
      break;
    case 'failed':
      message = `${messageContext} export failed.`;
      break;
    default:
      message = `${messageContext} export status: ${status || 'unknown'}.`;
  }

  const data = {
    jobId: job.jobId,
    jobType: job.type,
    fileName: job.meta?.downloadName || messageContext,
    status,
  };
  if (downloadUrl) data.downloadUrl = downloadUrl;
  if (typeof processed === 'number' && typeof total === 'number') {
    data.progress = { processed, total };
  }

  try {
    await notifyAndStore(job.userId.toString(), {
      type: 'inspection-export-status',
      title: job.type === REPORT_JOB_TYPES.PROJECT_FULL ? 'Project export' : 'Inspection export',
      message,
      data,
      meta: { route: '/inspections/exports', jobId: job.jobId }
    });
  } catch (err) {
    console.warn('⚠️ Failed to push export job status notification', err?.message || err);
  }
}

function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume(); // drain
        return reject(new Error(`Failed to fetch image: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function logoFitSize(buffer, maxWidth = 117.5, maxHeight = 53.5, fit = 'contain') {
  try {
    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (!width || !height) return { width: maxWidth, height: maxHeight };
    const scale = fit === 'cover'
      ? Math.max(maxWidth / width, maxHeight / height)
      : Math.min(maxWidth / width, maxHeight / height);
    return {
      width: Math.max(1, width * scale),
      height: Math.max(1, height * scale)
    };
  } catch {
    return { width: maxWidth, height: maxHeight };
  }
}

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

async function addZoneScopeToEquipmentFilter({ tenantId, zoneId, equipmentFilter, includeDescendants = false }) {
  if (!zoneId) return;
  const ids = includeDescendants
    ? (await Unit.find({ tenantId, $or: [{ _id: zoneId }, { ancestors: zoneId }] }).select('_id').lean()).map(u => u._id)
    : [zoneId];
  equipmentFilter.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
}

function toObjectIdOrValue(value) {
  if (!value) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = value.toString ? value.toString() : String(value);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : value;
}

function objectIdString(value) {
  return value && value.toString ? value.toString() : String(value || '');
}

async function attachInspectorsToInspections(inspections = []) {
  const inspectorIds = [
    ...new Set(
      inspections
        .map(insp => insp?.inspectorId)
        .filter(Boolean)
        .map(objectIdString)
        .filter(id => mongoose.isValidObjectId(id))
    )
  ];
  if (!inspectorIds.length) return inspections;

  const users = await User.find({ _id: { $in: inspectorIds.map(id => new mongoose.Types.ObjectId(id)) } })
    .select(REPORT_INSPECTOR_SELECT)
    .lean();
  const userById = new Map(users.map(user => [objectIdString(user._id), user]));

  inspections.forEach((insp) => {
    const key = objectIdString(insp?.inspectorId);
    if (userById.has(key)) {
      insp.inspectorId = userById.get(key);
    }
  });
  return inspections;
}

async function loadLatestInspectionMapForEquipments(equipments = [], tenantId) {
  const inspectionByEquipment = new Map();
  const inspectionById = new Map();
  if (!Array.isArray(equipments) || !equipments.length) {
    return { inspectionByEquipment, inspectionById };
  }

  const tenantValue = toObjectIdOrValue(tenantId);
  const equipmentIds = equipments
    .map(eq => eq?._id)
    .filter(Boolean);

  const lastInspectionIds = [
    ...new Set(
      equipments
        .map(eq => eq?.lastInspectionId)
        .filter(Boolean)
        .map(objectIdString)
        .filter(id => mongoose.isValidObjectId(id))
    )
  ];

  if (lastInspectionIds.length) {
    const docs = await Inspection.find({
      _id: { $in: lastInspectionIds.map(id => new mongoose.Types.ObjectId(id)) },
      tenantId
    }).lean();
    await attachInspectorsToInspections(docs);
    docs.forEach((insp) => {
      if (!insp?._id) return;
      inspectionById.set(objectIdString(insp._id), insp);
    });

    equipments.forEach((eq) => {
      const id = objectIdString(eq?.lastInspectionId);
      const insp = id ? inspectionById.get(id) : null;
      if (insp) inspectionByEquipment.set(objectIdString(eq._id), insp);
    });
  }

  const missingEquipmentIds = equipmentIds.filter(
    id => !inspectionByEquipment.has(objectIdString(id))
  );
  if (missingEquipmentIds.length) {
    const latest = await Inspection.aggregate([
      {
        $match: {
          tenantId: tenantValue,
          equipmentId: { $in: missingEquipmentIds.map(toObjectIdOrValue) }
        }
      },
      { $sort: { equipmentId: 1, inspectionDate: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: '$equipmentId', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } }
    ]).allowDiskUse(true);
    await attachInspectorsToInspections(latest);
    latest.forEach((insp) => {
      if (!insp?.equipmentId) return;
      inspectionByEquipment.set(objectIdString(insp.equipmentId), insp);
      if (insp._id) inspectionById.set(objectIdString(insp._id), insp);
    });
  }

  return { inspectionByEquipment, inspectionById };
}

async function buildReportCertificateCache(tenantId, equipments = []) {
  const certNos = [
    ...new Set(
      (equipments || [])
        .map(eq => certificateNo(eq))
        .filter(Boolean)
        .map(value => String(value).trim())
        .filter(Boolean)
    )
  ];
  if (!certNos.length) return new Map();
  try {
    const merged = new Map();
    const chunkSize = 200;
    for (let i = 0; i < certNos.length; i += chunkSize) {
      const chunk = certNos.slice(i, i + chunkSize);
      const map = await buildCertificateCacheForCertNos(tenantId, chunk);
      map.forEach((value, key) => {
        if (!merged.has(key)) merged.set(key, value);
      });
    }
    return merged;
  } catch (err) {
    console.warn('⚠️ Certificate cache build failed for report:', err?.message || err);
    return new Map();
  }
}

async function resolveSchemeFromEquipment(equipment, certificateCache) {
  let scheme = '';
  const equipmentCertNo = certificateNo(equipment);

  if (!equipmentCertNo) {
    return scheme;
  }

  const cacheKey = equipmentCertNo.toUpperCase();
  if (certificateCache && certificateCache.has(cacheKey)) {
    const cached = certificateCache.get(cacheKey);
    if (cached && typeof cached === 'object') {
      return cached.scheme || '';
    }
    return cached || '';
  }

  const cachedDoc = resolveCertificateFromCache(certificateCache, equipmentCertNo);
  if (cachedDoc) {
    scheme = cachedDoc.scheme || '';
    if (!scheme) {
      const upperNo = equipmentCertNo.toUpperCase();
      const hasATEX = upperNo.includes('ATEX');
      const hasIECEX = upperNo.includes('IECEX');
      if (hasATEX && hasIECEX) scheme = 'ATEX / IECEx';
      else if (hasATEX) scheme = 'ATEX';
      else if (hasIECEX) scheme = 'IECEx';
    }
    if (certificateCache) {
      certificateCache.set(cacheKey, scheme);
    }
    return scheme;
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
  const zone = await getZoneCached(equipment.Unit || equipment.Zone, zoneCache);
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

function buildLegacyBlobPathFromMeta(meta) {
  if (!meta?.blobPath) return null;
  const siteName = meta.legacySiteName;
  const zoneName = meta.legacyZoneName;
  const eqId = meta.legacyEqId;
  if (!siteName || !zoneName || !eqId) return null;
  const normalized = azureBlob.toBlobPath(meta.blobPath);
  const parts = normalized.split('/').filter(Boolean);
  const idx = parts.indexOf('projects');
  if (idx === -1) return null;
  const root = parts.slice(0, idx).join('/');
  const fileName = parts[parts.length - 1];
  const safeSite = sanitizeFileNameSegment(siteName, 'site');
  const safeZone = sanitizeFileNameSegment(zoneName, 'zone');
  const safeEq = sanitizeFileNameSegment(eqId, 'equipment');
  return `${root}/projects/${safeSite}/${safeZone}/${safeEq}/${fileName}`;
}

async function downloadWithLegacyFallback(meta) {
  const primary = meta?.blobPath;
  if (!primary) return null;
  try {
    return await azureBlob.downloadToBuffer(primary);
  } catch {
    const legacyPath = buildLegacyBlobPathFromMeta(meta);
    if (!legacyPath) throw new Error('blob download failed');
    return await azureBlob.downloadToBuffer(legacyPath);
  }
}

function setDownloadHeaders(res, fileName, contentType) {
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  if (fileName) {
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  }

  const existingExpose = res.getHeader('Access-Control-Expose-Headers');
  const exposeValues = new Set();
  if (existingExpose) {
    existingExpose
      .toString()
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => exposeValues.add(value));
  }
  exposeValues.add('Content-Disposition');
  res.setHeader('Access-Control-Expose-Headers', Array.from(exposeValues).join(', '));
}

function buildEquipmentIdentifier(equipment, context = {}) {
  if (!equipment) return null;

  /*
  const rawOrder =
    equipment.orderIndex ??
    equipment.OrderIndex ??
    equipment['orderIndex'] ??
    equipment['OrderIndex'];
  const orderIndex =
    typeof rawOrder === 'number' && /^\d+$/.test(rawOrder.toString())
      ? rawOrder.toString()
      : null;

  const rawTag =
    equipment.TagNo ||
    equipment['TagNo'] ||
    equipment['Tag No'] ||
    equipment.tagNo ||
    equipment.tag ||
    equipment.Tag ||
    equipment.TagID ||
    equipment.tagID ||
    equipment.tagId ||
    equipment.TagId ||
    null;
  const tag =
    typeof rawTag === 'string' && rawTag.trim().length ? rawTag.trim() : null;

  const eqId =
    equipment.EqID ||
    equipment.eqId ||
    equipment.EqId ||
    (typeof equipment['EqID'] === 'string' ? equipment['EqID'] : null) ||
    null;

  const parts = [orderIndex, tag, eqId]
    .map(part => (typeof part === 'string' ? part.trim() : part))
    .filter(part => !!part && part.toString().length > 0);

  if (!parts.length) return null;
  return parts.join('-');
  */

  const rawOrder =
    equipment.orderIndex ??
    equipment.OrderIndex ??
    equipment['orderIndex'] ??
    equipment['OrderIndex'];
  const orderIndex =
    typeof rawOrder === 'number' && /^\d+$/.test(rawOrder?.toString?.() || '')
      ? rawOrder.toString()
      : null;

  const siteClient =
    context.site?.Client ||
    context.site?.client ||
    context.siteClient ||
    equipment.siteClient ||
    equipment.SiteClient ||
    equipment.Client ||
    equipment.client ||
    equipment.site?.Client ||
    equipment.Site?.Client ||
    null;

  const zoneDescription =
    context.zone?.Description ||
    context.zoneDescription ||
    equipment.zoneDescription ||
    equipment.ZoneDescription ||
    equipment.zone?.Description ||
    equipment.Zone?.Description ||
    equipment.ZoneDescription ||
    null;

  const equipmentCertificateNo =
    context.certificateNo ||
    equipment.certificateNo ||
    equipment.CertificateNo ||
    certificateNo(equipment) ||
    equipment['Declaration of conformity'] ||
    null;

  const parts = [orderIndex, siteClient || zoneDescription, equipmentCertificateNo]
    .map(part => (typeof part === 'string' ? part.trim() : part))
    .filter(part => !!part && part.toString().length > 0);

  if (!parts.length) return null;
  return parts.join('-');
}

function deriveQuestionReference(result) {
  if (!result) return '';
  const explicit = String(result.reference || '').trim();
  if (explicit) return explicit;
  const tableVal = (result.table || result.Table || '').toString();
  const numRaw = result.number ?? result.Number;
  if (tableVal === 'SC' || result.equipmentType === 'Special Condition') {
    const num = typeof numRaw === 'number' ? numRaw : 1;
    return `SC${num}`;
  }
  if (tableVal && (numRaw || numRaw === 0)) {
    return `${tableVal}-${numRaw}`;
  }
  if (numRaw || numRaw === 0) {
    return `${numRaw}`;
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

function buildInspectionAttachmentLookup(inspection, eqId, identifier = null, legacyContext = null) {
  const eqFolder = sanitizeFileNameSegment(
    identifier || eqId || inspection?.eqId || inspection?.equipmentId || 'equipment'
  );
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
    if (legacyContext) {
      meta.legacySiteName = legacyContext.siteName || null;
      meta.legacyZoneName = legacyContext.zoneName || null;
      meta.legacyEqId = legacyContext.eqId || null;
    }
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
    const buffer = await downloadWithLegacyFallback(meta);
      const folder = sanitizeFileNameSegment(meta.eqFolder || 'equipment');
      const zipPath = path.posix.join(imagesRoot, folder, meta.fileName);
      archive.append(buffer, { name: zipPath });
    } catch (err) {
      console.error('⚠️ Failed to append inspection image to archive:', err?.message || err);
    }
  }
}

function normalizeDocumentMeta(doc = {}, eqFolder, fallbackPrefix, defaultExt = '.bin') {
  if (!doc?.blobPath) return null;
  const originalName = doc.name || doc.alias || doc.fileName || fallbackPrefix;
  const ext =
    path.extname(originalName || '') ||
    path.extname(doc.blobPath || '') ||
    defaultExt;
  const base = path.basename(originalName || fallbackPrefix, ext);
  const safeBase = sanitizeFileNameSegment(base, fallbackPrefix);
  return {
    blobPath: doc.blobPath,
    eqFolder,
    fileName: `${safeBase}${ext}`
  };
}

function collectEquipmentDocuments(equipment, eqFolder, legacyContext = null) {
  const docs = Array.isArray(equipment?.documents) ? equipment.documents : [];
  const documentMetas = [];
  const imageMetas = [];
  docs.forEach((doc, idx) => {
    if (!doc?.blobPath) return;
    const fallback = `doc_${idx + 1}`;
    const meta = normalizeDocumentMeta(doc, eqFolder, fallback, '.bin');
    if (!meta) return;
    if (legacyContext) {
      meta.legacySiteName = legacyContext.siteName || null;
      meta.legacyZoneName = legacyContext.zoneName || null;
      meta.legacyEqId = legacyContext.eqId || null;
    }
    if (String(doc.type || '').toLowerCase() === 'image') {
      imageMetas.push(meta);
    } else {
      documentMetas.push(meta);
    }
  });
  return { documentMetas, imageMetas };
}

function collectInspectionDocumentAttachments(inspection, eqFolder, legacyContext = null) {
  const attachments = Array.isArray(inspection?.attachments) ? inspection.attachments : [];
  const docs = [];
  attachments.forEach((att, idx) => {
    if (!att?.blobPath) return;
    if (att.type && att.type !== 'document') return;
    const fallback = `inspection_doc_${idx + 1}`;
    const meta = normalizeDocumentMeta(att, eqFolder, fallback, '.pdf');
    if (meta && legacyContext) {
      meta.legacySiteName = legacyContext.siteName || null;
      meta.legacyZoneName = legacyContext.zoneName || null;
      meta.legacyEqId = legacyContext.eqId || null;
    }
    if (meta) docs.push(meta);
  });
  return docs;
}

async function appendDocumentsToArchive(archive, docs, documentsRoot = 'documents') {
  if (!Array.isArray(docs) || !docs.length) return;
  for (const doc of docs) {
    if (!doc?.blobPath) continue;
    try {
    const buffer = await downloadWithLegacyFallback(doc);
      const folder = sanitizeFileNameSegment(doc.eqFolder || 'equipment');
      const zipPath = path.posix.join(documentsRoot, folder, doc.fileName);
      archive.append(buffer, { name: zipPath });
    } catch (err) {
      console.error('⚠️ Failed to append document to archive:', err?.message || err);
    }
  }
}

function orderEquipmentPicturesForItr(equipment, legacyContext = null) {
  const ordered = [];
  const seen = new Set();
  if (!equipment) return ordered;

  const pushUnique = (pic) => {
    if (!pic) return;
    const key = pic.blobPath || pic.blobUrl || pic.fileName || pic._id?.toString();
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (legacyContext) {
      pic.legacySiteName = legacyContext.siteName || null;
      pic.legacyZoneName = legacyContext.zoneName || null;
      pic.legacyEqId = legacyContext.eqId || null;
    }
    ordered.push(pic);
  };

  const docImagesRaw = Array.isArray(equipment.documents)
    ? equipment.documents.filter(doc => doc && (doc.blobPath || doc.blobUrl) && String(doc.type || 'document').toLowerCase() === 'image')
    : [];

  const normalizeTimestamp = (value) => {
    const date = value ? new Date(value) : null;
    const time = date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
    return time;
  };

  const docDataplate = docImagesRaw
    .filter(doc => String(doc.tag || '').toLowerCase() === 'dataplate')
    .map(doc => ({ doc, ts: normalizeTimestamp(doc.uploadedAt) }))
    .sort((a, b) => a.ts - b.ts);
  const docOthers = docImagesRaw
    .filter(doc => String(doc.tag || '').toLowerCase() !== 'dataplate')
    .map(doc => ({ doc, ts: normalizeTimestamp(doc.uploadedAt) }))
    .sort((a, b) => a.ts - b.ts);

  docDataplate.forEach(({ doc }) => pushUnique(doc));
  docOthers.forEach(({ doc }) => pushUnique(doc));

  const equipmentPictures = Array.isArray(equipment.Pictures)
    ? equipment.Pictures.filter(pic => pic && (pic.blobPath || pic.blobUrl))
    : [];
  if (equipmentPictures.length) {
    const picDataplate = equipmentPictures.filter(pic => String(pic.tag || '').toLowerCase() === 'dataplate');
    const picOthers = equipmentPictures.filter(pic => String(pic.tag || '').toLowerCase() !== 'dataplate');
    picDataplate.forEach(pushUnique);
    picOthers.forEach(pushUnique);
  }

  return ordered;
}

function resolvePictureExtension(pic, metadata = {}) {
  const format = String(metadata?.format || '').toLowerCase();
  if (format === 'png') return 'png';
  if (format === 'jpeg' || format === 'jpg') return 'jpeg';
  const type = String(pic?.contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('jpg') || type.includes('jpeg')) return 'jpeg';
  const name = String(pic?.name || pic?.alias || '').toLowerCase();
  if (name.endsWith('.png')) return 'png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpeg';
  return 'jpeg';
}

function deriveImageTitle(rawTitle, options = {}) {
  const { isFirst, nextImageIndex, reference, isFault, fallbackName } = options;
  if (isFirst) return 'Dataplate';
  if (reference) return `Error ${reference}`;
  if (isFault) {
    const base = rawTitle || fallbackName;
    if (base) return base.replace(/\.[^.]+$/, '');
    return 'Failure Image';
  }
  const idx = nextImageIndex || 1;
  return `Image ${idx}`;
}

async function prepareEquipmentImageForWorksheet(picture, workbook, targetWidthPx = 320, options = {}) {
  if (!picture) return null;
  const sourcePath = picture.blobPath || picture.blobUrl;
  if (!sourcePath) return null;
  try {
    const buffer = await downloadWithLegacyFallback({
      blobPath: sourcePath,
      legacySiteName: picture.legacySiteName,
      legacyZoneName: picture.legacyZoneName,
      legacyEqId: picture.legacyEqId
    });
    let metadata = {};
    try {
      metadata = await sharp(buffer).metadata();
    } catch {}
    const extension = resolvePictureExtension(picture, metadata);
    const imgWidth = metadata?.width || null;
    const imgHeight = metadata?.height || null;
    const aspectRatio = imgWidth && imgHeight && imgWidth > 0 ? imgHeight / imgWidth : 0.75;
    const computedHeight = targetWidthPx * aspectRatio;
    const minHeight = 140;
    const maxHeight = 500;
    const targetHeightPx = Math.max(minHeight, Math.min(maxHeight, computedHeight || minHeight));
    const imageId = workbook.addImage({ buffer, extension });
    const rawTitle = picture?.alias || picture?.name || picture?.tag || picture?.fileName;
    const lastSegment = sourcePath.split(/[\\/]/).pop() || '';
    const cleanSegment = lastSegment.split('?')[0] || lastSegment;
    const fallbackName = cleanSegment.replace(/\.[^.]+$/, '');
    const reference = picture?.questionReference || picture?.reference || null;
    const title = deriveImageTitle(rawTitle, {
      isFirst: options?.isFirst,
      nextImageIndex: options?.nextImageIndex,
      reference,
      isFault: options?.isFault || String(picture?.tag || '').toLowerCase() === 'fault',
      fallbackName
    });
    return {
      imageId,
      widthPx: targetWidthPx,
      heightPx: targetHeightPx,
      title,
      reference
    };
  } catch (err) {
    try { console.warn('⚠️ Failed to prepare equipment image for ITR:', err?.message || err); } catch {}
    return null;
  }
}

async function appendItrEquipmentImagesSection(ws, workbook, equipment, attachmentLookup, context = {}) {
  if (!equipment && !attachmentLookup) return;
  const orderedPictures = orderEquipmentPicturesForItr(equipment, {
    siteName: context.site?.Name || context.site?.SiteName || null,
    zoneName: context.zone?.Name || context.zone?.ZoneName || null,
    eqId: equipment?.EqID || context.inspection?.eqId || null
  });
  const attachmentPictures = Array.isArray(attachmentLookup?.all)
    ? attachmentLookup.all.filter(img => img && (img.blobPath || img.blobUrl))
    : [];

  attachmentPictures.forEach(att => {
    if (!att) return;
    const ref = att.questionReference || att.questionKey || att.reference || null;
    if (ref) {
      att.questionReference = ref;
      if (!att.tag) att.tag = 'fault';
      if (!att.alias) att.alias = `Failure - ${ref}`;
    }
  });

  const sources = [...orderedPictures, ...attachmentPictures];
  if (!sources.length) return;

  const preparedImages = [];
  let nonDataplateIndex = 1;
  const faultNameCounters = new Map();

  for (let idx = 0; idx < sources.length; idx += 1) {
    const pic = sources[idx];
    const isFirst = idx === 0;
    const options = {
      isFirst,
      nextImageIndex: nonDataplateIndex,
      isFault: String(pic?.tag || '').toLowerCase() === 'fault'
    };
    const meta = await prepareEquipmentImageForWorksheet(pic, workbook, 320, options);
    if (meta) {
      if (meta.reference) {
        const current = (faultNameCounters.get(meta.reference) || 0) + 1;
        faultNameCounters.set(meta.reference, current);
        if (current > 1) {
          meta.title = `${meta.title} (${current})`;
        }
      }
      preparedImages.push(meta);
      if (!isFirst && !meta.title.startsWith('Error')) {
        nonDataplateIndex += 1;
      }
    }
  }

  if (!preparedImages.length) return;

  const firstPair = preparedImages.slice(0, 2);
  const firstImageRowHeight = Math.max(40, ...firstPair.map(img => (img.heightPx * 72) / 96)) + 10;
  ensureNextBlockFitsOnPage(ws, 7 + 22 + 18 + firstImageRowHeight);

  const spacerBefore = ws.addRow([]);
  spacerBefore.height = 7;

  const headerRow = ws.addRow([]);
  ws.mergeCells(`A${headerRow.number}:N${headerRow.number}`);
  const headerCell = ws.getCell(`A${headerRow.number}`);
  headerCell.value = 'Images';
  headerCell.font = { bold: true, size: 14 };
  headerCell.alignment = { horizontal: 'left', vertical: 'middle' };
  headerCell.fill = HEADER_FILL;
  headerCell.border = BORDER_THIN;
  headerRow.height = 22;

  const columnRanges = [
    { startCol: 'A', endCol: 'G' },
    { startCol: 'H', endCol: 'N' }
  ];

  for (let i = 0; i < preparedImages.length; i += 2) {
    const pair = preparedImages.slice(i, i + 2);
    const maxHeightPoints = Math.max(40, ...pair.map(img => (img.heightPx * 72) / 96));
    const imageRowHeight = maxHeightPoints + 10;
    ensureNextBlockFitsOnPage(ws, 18 + imageRowHeight);

    const titleRow = ws.addRow([]);
    titleRow.height = 18;
    pair.forEach((img, idx) => {
      const range = `${columnRanges[idx].startCol}${titleRow.number}:${columnRanges[idx].endCol}${titleRow.number}`;
      ws.mergeCells(range);
      const titleCell = ws.getCell(`${columnRanges[idx].startCol}${titleRow.number}`);
      if (idx === 0 && i === 0) {
        titleCell.value = 'Dataplate';
      } else {
        const imageNumber = i + idx + 1;
        titleCell.value = img.title || `Image ${imageNumber}`;
      }
      titleCell.font = { bold: true };
      titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
      titleCell.border = BORDER_THIN;
    });

    const imageRow = ws.addRow([]);
    imageRow.height = imageRowHeight;

    pair.forEach((img, idx) => {
      const range = `${columnRanges[idx].startCol}${imageRow.number}:${columnRanges[idx].endCol}${imageRow.number}`;
      ws.mergeCells(range);
      const anchorCell = ws.getCell(`${columnRanges[idx].startCol}${imageRow.number}`);
      anchorCell.border = BORDER_THIN;

      const columnOffset = idx === 0 ? 0 : 7.5;
      ws.addImage(img.imageId, {
        tl: { col: columnOffset, row: imageRow.number - 1 },
        ext: { width: img.widthPx, height: img.heightPx }
      });
    });
  }

  const spacerAfter = ws.addRow([]);
  spacerAfter.height = 7;
}

function setupArchiveStream(targetStream) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  let byteCount = 0;
  archive.on('data', chunk => {
    if (chunk) {
      byteCount += chunk.length;
    }
  });
  const finalized = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  archive.pipe(targetStream);
  return { archive, finalized, getByteCount: () => byteCount };
}

async function buildInspectionWorkbook(inspection, equipment, site, zone, scheme, attachmentLookup = null, options = {}) {
  // -------- Excel workbook + sheet --------
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Inspection Report');
  const topRowHeight = 25;
  const areaEquipmentRowHeight = 30;
  const checklistHeaderRowHeight = 18;
  const checklistMinRowHeight = 18;
  const checklistLineHeight = 17;
  const titleHeaderRowHeight = 19;
  const logoHeaderHeightPx = Math.round(titleHeaderRowHeight * 2 * 96 / 72);

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

  const topDataRowHeight = (values = []) => {
    const maxTextLength = values.reduce((max, value) => {
      if (value instanceof Date) return max;
      const len = String(value ?? '').length;
      return Math.max(max, len);
    }, 1);
    const lineCount = Math.max(1, Math.ceil(maxTextLength / 23));
    return Math.max(topRowHeight, lineCount * 16);
  };

  const estimateWrappedLineCount = (text, charsPerLine) => {
    const safeCharsPerLine = Math.max(1, Number(charsPerLine) || 1);
    const parts = String(text || '')
      .split(/\r?\n/)
      .map(part => part.trim());
    if (!parts.length) return 1;
    return parts.reduce((sum, part) => {
      const len = part.length || 1;
      return sum + Math.max(1, Math.ceil(len / safeCharsPerLine));
    }, 0);
  };

  // Oszlopszélességek – kb. a tervhez igazítva
  ws.columns = DEFAULT_COLUMNS;

  const inspectionDate = inspection.inspectionDate
    ? new Date(inspection.inspectionDate)
    : new Date();

  const inspectorDoc = inspection.inspectorId || null;
  const inspectorName = inspectorDoc
    ? `${inspectorDoc.firstName || ''} ${inspectorDoc.lastName || inspectorDoc.name || ''}`.trim()
    : '';
  const inspectorPosition = inspectorDoc?.position || '';
  const inspectorPositionInfo = inspectorDoc?.positionInfo || '';
  const inspectorSignatureUrl =
    inspectorDoc?.signatureBlobUrl ||
    (inspectorDoc?.signatureBlobPath ? azureBlob.getBlobUrl(inspectorDoc.signatureBlobPath) : null);
  const tenantLogoUrl = options.tenantLogoUrl || await getTenantReportLogoUrl(options.tenantId || inspection.tenantId);

  const tenantName = (options.tenantName || '').toLowerCase();
  const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';
  const exMarking = primaryEquipmentMarking(equipment);
  const protectionTokens = String(exMarking['Type of Protection'] || '')
    .toLowerCase()
    .split(/[,\s;/+]+/)
    .map(token => token.trim())
    .filter(Boolean);
  const nonElectricalProtectionTypes = new Set(['b', 'c', 'h', 'k']);
  const hasNonElectricalProtection = protectionTokens.some(token => nonElectricalProtectionTypes.has(token));
  const hasElectricalProtection = protectionTokens.some(token => !nonElectricalProtectionTypes.has(token));

  applyOnePageWidePrintSetup(ws);

  // ========= 1. sor – tenant logo + cím + electrical marker + dátum =========
  try {
    const logoBuffer = await fetchImageBuffer(tenantLogoUrl || INDEX_LOGO_URL);
    const imageId = workbook.addImage({
      buffer: logoBuffer,
      extension: 'png'
    });
    const logoSize = await logoFitSize(logoBuffer, 125, logoHeaderHeightPx, 'cover');
    ws.addImage(imageId, {
      tl: { col: 0, row: 0 },
      ext: logoSize
    });
    ws.mergeCells('A1:B2');
  } catch (e) {
    // ha nem sikerül, csak simán üresen hagyjuk a logó helyét
    ws.mergeCells('A1:B2');
  }

  ['A','B'].forEach(col => {
    [1,2].forEach(rn => {
      const cell = ws.getCell(`${col}${rn}`);
      cell.fill = HEADER_FILL;
    });
  });

  ws.mergeCells('C1:I2');
  const titleCell = ws.getCell('C1');
  const typeLabel = displayInspectionTypeForHeader(inspection);
  titleCell.value = typeLabel
    ? {
        richText: [
          { text: 'Inspection Test Report', font: { bold: true, size: 16 } },
          { text: `\nType: ${typeLabel}`, font: { bold: false, size: 11 } }
        ]
      }
    : 'Inspection Test Report';
  if (!typeLabel) titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  titleCell.fill = HEADER_FILL;

  ws.mergeCells('J1:K1');
  ws.getCell('J1').value = 'Electrical';
  ws.getCell('J1').font = { bold: true, size: 11 };
  ws.getCell('J1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('J1').fill = HEADER_FILL;
  ws.getCell('L1').value = hasElectricalProtection ? 'x' : '';
  ws.getCell('L1').font = { bold: true, size: 11 };
  ws.getCell('L1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('L1').fill = HEADER_FILL;

  ws.mergeCells('J2:K2');
  ws.getCell('J2').value = 'Non-Electrical';
  ws.getCell('J2').font = { bold: true, size: 11 };
  ws.getCell('J2').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('J2').fill = HEADER_FILL;
  ws.getCell('L2').value = hasNonElectricalProtection ? 'x' : '';
  ws.getCell('L2').font = { bold: true, size: 11 };
  ws.getCell('L2').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('L2').fill = HEADER_FILL;

  ws.mergeCells('M1:M2');
  ws.getCell('M1').value = 'Date:';
  ws.getCell('M1').font = { bold: true, size: 11 };
  ws.getCell('M1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('M1').fill = HEADER_FILL;

  ws.mergeCells('N1:N2');
  ws.getCell('N1').value = inspectionDate;
  ws.getCell('N1').font = { size: 11 };
  ws.getCell('N1').numFmt = 'yyyy-mm-dd';
  ws.getCell('N1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('N1').fill = HEADER_FILL;

  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
    [1,2].forEach(rn => {
      const cell = ws.getCell(`${col}${rn}`);
      cell.border = BORDER_THIN;
    });
  });

  // Címsorok magassága – két soros cím + fix méretű logó
  ws.getRow(1).height = titleHeaderRowHeight;
  ws.getRow(2).height = titleHeaderRowHeight;

  // üres sor (3)
  const emptyRow3 = ws.addRow([]);
  emptyRow3.height = 7;

  let currentRow = 4;
  const spacerHeight = 5;

  // Client / Project / Zone
  const clientRow = currentRow;
  const clientRowValues = [
    isIndexTenant ? (zone?.SkidID || '') : (site?.Client || ''),
    isIndexTenant ? (zone?.SkidDescription || zone?.Name || '') : (site?.Name || ''),
    isIndexTenant ? (site?.Name || '') : (zone?.Name || zone?.ZoneName || '')
  ];
  setHeaderCell(`A${clientRow}:B${clientRow}`, isIndexTenant ? 'Skid ID' : 'Client name');
  setValueCell(`C${clientRow}:E${clientRow}`, clientRowValues[0]);
  setHeaderCell(`F${clientRow}:G${clientRow}`, isIndexTenant ? 'Skid Description' :'Project');
  setValueCell(`H${clientRow}:J${clientRow}`, clientRowValues[1]);
  setHeaderCell(`K${clientRow}:L${clientRow}`, isIndexTenant ? 'Project' : 'Zone');
  setValueCell(`M${clientRow}:N${clientRow}`, clientRowValues[2]);
  ws.getRow(clientRow).height = topDataRowHeight(clientRowValues);
  currentRow += 1;

  const tagIdValue = equipment?.TagNo || equipment?.['TagNo'] || equipment?.['Tag No'] || equipment?.tagId || '';
  const hasTagId = !!tagIdValue;
  let tagRowIndex = null;

  if (hasTagId) {
    tagRowIndex = currentRow;
    const tagRowValues = [
      tagIdValue,
      equipment.EqID || '',
      equipment['Equipment Type'] || equipment.EquipmentType || ''
    ];
    setHeaderCell(`A${tagRowIndex}:B${tagRowIndex}`, isIndexTenant ? 'Voith ID Tag' : 'Tag ID');
    setValueCell(`C${tagRowIndex}:E${tagRowIndex}`, tagRowValues[0]);

    setHeaderCell(`F${tagRowIndex}:G${tagRowIndex}`, isIndexTenant ? 'Project ID Tag' : 'Equipment ID');
    setValueCell(`H${tagRowIndex}:J${tagRowIndex}`, tagRowValues[1]);

    setHeaderCell(`K${tagRowIndex}:L${tagRowIndex}`, 'Equipment Description');
    setValueCell(`M${tagRowIndex}:N${tagRowIndex}`, tagRowValues[2]);
    ws.getRow(tagRowIndex).height = topDataRowHeight(tagRowValues);
    currentRow += 1;
  }

  const equipmentRow = currentRow;
  let equipmentRowValues;
  if (hasTagId) {
    equipmentRowValues = [
      equipment.Manufacturer || '',
      equipment['Model/Type'] || '',
      equipment['Serial Number'] || equipment.SerialNumber || ''
    ];
    setHeaderCell(`A${equipmentRow}:B${equipmentRow}`, 'Manufacturer');
    setValueCell(`C${equipmentRow}:E${equipmentRow}`, equipmentRowValues[0]);
    setHeaderCell(`F${equipmentRow}:G${equipmentRow}`, 'Model');
    setValueCell(`H${equipmentRow}:J${equipmentRow}`, equipmentRowValues[1]);
    setHeaderCell(`K${equipmentRow}:L${equipmentRow}`, 'Serial No');
    setValueCell(`M${equipmentRow}:N${equipmentRow}`, equipmentRowValues[2]);
  } else {
    equipmentRowValues = [
      equipment.EqID || '',
      equipment.Manufacturer || '',
      equipment['Model/Type'] || ''
    ];
    setHeaderCell(`A${equipmentRow}:B${equipmentRow}`, 'Equipment ID');
    setValueCell(`C${equipmentRow}:E${equipmentRow}`, equipmentRowValues[0]);
    setHeaderCell(`F${equipmentRow}:G${equipmentRow}`, 'Manufacturer');
    setValueCell(`H${equipmentRow}:J${equipmentRow}`, equipmentRowValues[1]);
    setHeaderCell(`K${equipmentRow}:L${equipmentRow}`, 'Model');
    setValueCell(`M${equipmentRow}:N${equipmentRow}`, equipmentRowValues[2]);
  }
  ws.getRow(equipmentRow).height = topDataRowHeight(equipmentRowValues);
  currentRow += 1;

  // ========= Certificate / Ex scheme =========
  const certificateRow = currentRow;
  const statusValue = inspection.status || '';
  const equipmentRbScheme = String(getRbValues(equipment)?.scheme || '').trim();
  const certificateRowValues = [
    certificateNo(equipment) || '',
    equipmentRbScheme || scheme || '',
    statusValue
  ];
  setHeaderCell(`A${certificateRow}:B${certificateRow}`, 'Certificate no');
  setValueCell(`C${certificateRow}:E${certificateRow}`, certificateRowValues[0]);
  setHeaderCell(`F${certificateRow}:G${certificateRow}`, 'Ex scheme');
  setValueCell(`H${certificateRow}:J${certificateRow}`, certificateRowValues[1]);
  setHeaderCell(`K${certificateRow}:L${certificateRow}`, 'Status');
  const isPassed = statusValue === 'Passed';
  const isFailed = statusValue === 'Failed';
  setValueCell(`M${certificateRow}:N${certificateRow}`, certificateRowValues[2]);
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
  ws.getRow(certificateRow).height = topDataRowHeight(certificateRowValues);
  currentRow += 1;

  // üres sor
  const spacerRowIndex = currentRow;
  const spacerRow = ws.getRow(spacerRowIndex);
  spacerRow.height = spacerHeight;
  currentRow += 1;

  // ========= Area vs Equipment =========

  const zoneDisplays = zoneRbDisplays(zone);
  const zoneNumber = zoneDisplays.zoneNumber;
  const zoneSubGroup = zoneDisplays.subGroup;
  const zoneTempDisplay = zoneDisplays.temp;
  const ambientDisplay = zoneDisplays.ambient;
  const zoneIpRating = zoneDisplays.ipRating;
  const zoneEpl = zoneDisplays.epl;

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
  ws.getCell(`L${areaRow}`).value = zoneIpRating || '';

  ws.getCell(`M${areaRow}`).value = 'EPL';
  ws.getCell(`M${areaRow}`).font = { bold: true };
  ws.getCell(`M${areaRow}`).fill = HEADER_FILL;
  ws.getCell(`N${areaRow}`).value = zoneEpl;

  const equipmentInfoRow = areaRow + 1;

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

  ws.getRow(areaRow).height = areaEquipmentRowHeight;
  ws.getRow(equipmentInfoRow).height = areaEquipmentRowHeight;

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

  // enforce Area / Equipment comparison heights again (some cells wrap)
  [areaRow, equipmentInfoRow].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = areaEquipmentRowHeight;
  });
  ws.getRow(spacerRowIndex).height = spacerHeight;
  ws.getRow(spacerAfterBlockIndex).height = spacerHeight;

  // ========= Tenant-specific drawing block (Index) =========
  if (isIndexTenant && Array.isArray(zone?.documents) && zone.documents.length) {
    const docs = zone.documents || [];
    const usedIds = new Set();
    let hacDoc = null;
    const otherDrawingDocs = [];

    for (const doc of docs) {
      const aliasRaw = doc?.alias || '';
      const alias = String(aliasRaw || '').trim();
      const lowerAlias = alias.toLowerCase();
      if (!lowerAlias.includes('drawing')) continue;

      const idStr = doc?._id ? String(doc._id) : `${alias}::${doc.name || ''}`;
      if (usedIds.has(idStr)) continue;
      usedIds.add(idStr);

      if (!hacDoc && lowerAlias === 'hac drawing') {
        hacDoc = doc;
      } else {
        otherDrawingDocs.push(doc);
      }
    }

    const hasAnyDrawing = hacDoc || otherDrawingDocs.length;
    if (hasAnyDrawing) {
      const totalRows = Math.max(1, otherDrawingDocs.length || (hacDoc ? 1 : 0));
      // If we render the Index-specific drawing block, reuse the spacer row directly
      // below the equipment info block as the first drawing row (no extra empty row above).
      const drawingStartRow = spacerAfterBlockIndex;
      const drawingEndRow = drawingStartRow + totalRows - 1;

      // HAC Drawing label (merged, grey)
      ws.mergeCells(`A${drawingStartRow}:B${drawingEndRow}`);
      const hacLabelCell = ws.getCell(`A${drawingStartRow}`);
      hacLabelCell.value = 'HAC Drawing';
      hacLabelCell.font = { bold: true };
      hacLabelCell.fill = HEADER_FILL;
      hacLabelCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

      // HAC Drawing value (merged similarly in height)
      ws.mergeCells(`C${drawingStartRow}:F${drawingEndRow}`);
      const hacValueCell = ws.getCell(`C${drawingStartRow}`);
      if (hacDoc) {
        hacValueCell.value = hacDoc.alias || hacDoc.name || '';
      } else {
        hacValueCell.value = '';
      }
      hacValueCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

      // Other Drawings label (merged)
      ws.mergeCells(`G${drawingStartRow}:H${drawingEndRow}`);
      const otherLabelCell = ws.getCell(`G${drawingStartRow}`);
      otherLabelCell.value = 'Other Drawings:';
      otherLabelCell.font = { bold: true };
      otherLabelCell.fill = HEADER_FILL;
      otherLabelCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

      // Rows for other drawings (alias + filename)
      for (let i = 0; i < totalRows; i += 1) {
        const rowIndex = drawingStartRow + i;
        const doc = otherDrawingDocs[i] || null;

        const aliasCell = ws.getCell(`I${rowIndex}`);
        const aliasMergeRange = `I${rowIndex}:J${rowIndex}`;
        ws.mergeCells(aliasMergeRange);
        const fileCellRange = `K${rowIndex}:N${rowIndex}`;
        ws.mergeCells(fileCellRange);
        const fileCell = ws.getCell(`K${rowIndex}`);

        if (doc) {
          aliasCell.value = doc.alias || '';
          fileCell.value = doc.name || '';
        } else {
          aliasCell.value = '';
          fileCell.value = '';
        }

        aliasCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        fileCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

        // Borders for drawing row
        ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
          const cell = ws.getCell(`${col}${rowIndex}`);
          cell.border = BORDER_THIN;
        });
      }

      // Match HAC / drawing block row heights so all text is visible
      // (override previous spacer height if needed).
      let maxTextLen = 0;
      if (hacDoc) {
        const hacText = `${hacDoc.alias || ''} ${hacDoc.name || ''}`.trim();
        maxTextLen = Math.max(maxTextLen, hacText.length);
      }
      otherDrawingDocs.forEach(d => {
        if (!d) return;
        const txt = `${d.alias || ''} ${d.name || ''}`.trim();
        maxTextLen = Math.max(maxTextLen, txt.length);
      });
      if (maxTextLen === 0) {
        maxTextLen = 10;
      }
      const approxCharsPerLine = 25;
      const lineCount = Math.max(1, Math.ceil(maxTextLen / approxCharsPerLine));
      const rowHeight = lineCount * 5 + 4; // 15 pt / line + kis ráhagyás

      for (let rn = drawingStartRow; rn <= drawingEndRow; rn += 1) {
        const row = ws.getRow(rn);
        row.height = rowHeight;
      }

      // Spacer after drawing block
      const afterDrawingSpacer = ws.getRow(drawingEndRow + 1);
      afterDrawingSpacer.height = spacerHeight;
    }
  }

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
    'Electrical Machines',
    'Lighting',
    'Installation',
    'Installation Electrical Machines',
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

  const checklistCheckCharsPerLine = isIndexTenant ? 82 : 62;
  const checklistCommentCharsPerLine = isIndexTenant ? 34 : 46;
  const groupHeaderRowHeight = 18;

  const estimateQuestionRowHeight = (result) => {
    const questionText =
      (result?.questionText && (result.questionText.hu || result.questionText.eng)) ||
      result?.question ||
      '';
    const imageNames = attachmentLookup ? attachmentLookup.getFileNamesForResult(result) : [];
    const commentCellInfo = buildCommentCellValueWithSeverity(result?.note, result?.severity, imageNames);
    const checkLineCount = estimateWrappedLineCount(questionText, checklistCheckCharsPerLine);
    const commentLineCount = estimateWrappedLineCount(commentCellInfo.text, checklistCommentCharsPerLine);
    const lineCount = Math.max(1, checkLineCount, commentLineCount);
    return Math.max(checklistMinRowHeight, lineCount * checklistLineHeight);
  };

  sortedGroupNames.forEach((groupName, groupIndex) => {
    const firstResult = grouped[groupName]?.[0] || null;
    if (firstResult) {
      ensureNextBlockFitsOnPage(
        ws,
        groupHeaderRowHeight + checklistHeaderRowHeight + estimateQuestionRowHeight(firstResult)
      );
    }

    // Csoportcím sor – teljes szélesség merge
    const groupRow = ws.addRow([groupName]);
    const gr = groupRow.number;
    ws.mergeCells(`A${gr}:N${gr}`);
    groupRow.height = groupHeaderRowHeight;

    // A teljes sor (A–N) formázása
    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${gr}`);
      cell.font = { bold: true };
      cell.fill = groupHeaderFill;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = BORDER_THIN;
    });

    const checklistLayout = isIndexTenant
      ? {
          checkStartCol: 'B',
          checkEndCol: 'H',
          passCol: 'I',
          failCol: 'J',
          naCol: 'K',
          commentStartCol: 'L',
          commentEndCol: 'N'
        }
      : {
          checkStartCol: 'B',
          checkEndCol: 'G',
          passCol: 'H',
          failCol: 'I',
          naCol: 'J',
          commentStartCol: 'K',
          commentEndCol: 'N'
        };

    // Header sor (Ref / Check / Pass / Fail / NA / Comment)
    const headerRow = ws.addRow([]);
    const hr = headerRow.number;
    ws.getCell(`A${hr}`).value = 'Ref';
    ws.getCell(`B${hr}`).value = 'Check';
    ws.getCell(`${checklistLayout.passCol}${hr}`).value = 'Pass';
    ws.getCell(`${checklistLayout.failCol}${hr}`).value = 'Fail';
    ws.getCell(`${checklistLayout.naCol}${hr}`).value = 'NA';
    ws.getCell(`${checklistLayout.commentStartCol}${hr}`).value = 'Comment';

    ws.mergeCells(`${checklistLayout.checkStartCol}${hr}:${checklistLayout.checkEndCol}${hr}`); // Check
    ws.mergeCells(`${checklistLayout.commentStartCol}${hr}:${checklistLayout.commentEndCol}${hr}`); // Comment

    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${hr}`);
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = BORDER_THIN;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    headerRow.height = checklistHeaderRowHeight;

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
      const commentCellInfo = buildCommentCellValueWithSeverity(r.note, r.severity, imageNames);

      const row = ws.addRow([]);

      const rn = row.number;
      ws.getCell(`A${rn}`).value = ref;
      ws.getCell(`B${rn}`).value = questionText;
      ws.getCell(`${checklistLayout.passCol}${rn}`).value = passedMark;
      ws.getCell(`${checklistLayout.failCol}${rn}`).value = failedMark;
      ws.getCell(`${checklistLayout.naCol}${rn}`).value = naMark;
      ws.getCell(`${checklistLayout.commentStartCol}${rn}`).value = commentCellInfo.value;

      // Merge check & comment cell blocks
      ws.mergeCells(`${checklistLayout.checkStartCol}${rn}:${checklistLayout.checkEndCol}${rn}`);
      ws.mergeCells(`${checklistLayout.commentStartCol}${rn}:${checklistLayout.commentEndCol}${rn}`);

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
      const checkCell = ws.getCell(`B${rn}`);
      checkCell.alignment = {
        horizontal: 'left',
        vertical: 'middle',
        wrapText: true
      };

      const commentCell = ws.getCell(`${checklistLayout.commentStartCol}${rn}`);
      commentCell.alignment = {
        horizontal: 'left',
        vertical: 'middle',
        wrapText: true
      };

      // Sor magasság becslése a kérdés hossza alapján,
      // hogy a teljes szöveg látható legyen több sorban is.
      const rowHeight = estimateQuestionRowHeight(r);
      ws.getRow(rn).height = rowHeight;
    });

    // Üres sor csak a csoportok között, a végső Remarks sor előtt ne legyen hézag.
    if (groupIndex < sortedGroupNames.length - 1) {
      const emptyRowBetweenGroups = ws.addRow([]);
      emptyRowBetweenGroups.height = 7;
    }
  });

  if (isIndexTenant || inspection?.remarks) {
    const remarksRow = ws.addRow([]);
    const remarksR = remarksRow.number;
    ws.mergeCells(`B${remarksR}:N${remarksR}`);
    ws.getCell(`A${remarksR}`).value = 'Remarks';
    ws.getCell(`A${remarksR}`).font = { bold: true };
    ws.getCell(`B${remarksR}`).value = inspection?.remarks || '';
    const remarksLineCount = estimateWrappedLineCount(inspection?.remarks || '', 105);
    remarksRow.height = Math.max(checklistMinRowHeight, remarksLineCount * checklistLineHeight);

    ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'].forEach(col => {
      const cell = ws.getCell(`${col}${remarksR}`);
      cell.border = BORDER_THIN;
      cell.alignment = {
        horizontal: col === 'A' ? 'center' : 'left',
        vertical: 'middle',
        wrapText: true
      };
    });
  }

  // ===== FOOTER: Created by / Signature =====

  // Háromsoros footer: Name / Position / IECEx CoPC#
  const nameRow = ws.addRow([]);
  const nameR = nameRow.number;
  const positionRow = ws.addRow([]);
  const positionR = positionRow.number;
  const copcRow = ws.addRow([]);
  const copcR = copcRow.number;

  const setFooterField = (rowNum, label, value) => {
    ws.mergeCells(`A${rowNum}:B${rowNum}`);
    ws.mergeCells(`C${rowNum}:G${rowNum}`);

    const labelCell = ws.getCell(`A${rowNum}`);
    const valueCell = ws.getCell(`C${rowNum}`);

    labelCell.value = label;
    labelCell.font = { bold: true, size: 14 };
    labelCell.alignment = { horizontal: 'center', vertical: 'middle' };
    labelCell.border = BORDER_THIN;

    valueCell.value = value || '';
    valueCell.font = { bold: !!value, size: 14 };
    valueCell.alignment = { horizontal: 'center', vertical: 'middle' };
    valueCell.border = BORDER_THIN;
  };

  setFooterField(nameR, 'Name:', inspectorName || '');
  setFooterField(positionR, 'Position:', inspectorPosition || '');
  setFooterField(copcR, 'IECEx CoPC#:', inspectorPositionInfo || '');

  // Sor magasság beállítása a signature anchor előtt, hogy az image pozíció stabil legyen.
  const footerRowHeight = 22;
  ws.getRow(nameR).height = footerRowHeight;
  ws.getRow(positionR).height = footerRowHeight;
  ws.getRow(copcR).height = footerRowHeight;

  // jobb oldali blokk: Signature (H–N oszlop, 3 sor magas)
  ws.mergeCells(`H${nameR}:N${copcR}`);
  const signatureCell = ws.getCell(`H${nameR}`);
  const signatureDateStr =
    inspectionDate instanceof Date ? inspectionDate.toISOString().slice(0, 10) : '';
  signatureCell.value = signatureDateStr
    ? `____________________________\nDate: ${signatureDateStr}`
    : '____________________________';
  signatureCell.font = { bold: true, size: 14 };
  signatureCell.alignment = { horizontal: 'center', vertical: 'bottom', wrapText: true };
  signatureCell.border = BORDER_THIN;

  // Ha van aláírás kép az inspectorhoz, illesszük be a "Signature" vonal fölé,
  // az eredeti képarány megtartásával.
  if (inspectorSignatureUrl) {
    try {
      const sigBuffer = await fetchImageBuffer(inspectorSignatureUrl);
      const meta = await sharp(sigBuffer).metadata();
      const origWidth = meta.width || 400;
      const origHeight = meta.height || 150;

      // Keep the signature on the line without dropping into the Date row.
      const targetHeight = 58;
      const scale = targetHeight / origHeight;
      const targetWidth = Math.round(origWidth * scale);

      const extension =
        meta.format === 'png'
          ? 'png'
          : meta.format === 'webp'
          ? 'webp'
          : 'jpeg';

      const imageId = workbook.addImage({
        buffer: sigBuffer,
        extension
      });

      ws.addImage(imageId, {
        tl: { col: 10.45, row: nameR - 1 + 0.28 },
        ext: { width: targetWidth, height: targetHeight }
      });
    } catch (e) {
      console.warn('⚠️ Failed to embed inspector signature image:', e?.message || e);
    }
  }

  await appendItrEquipmentImagesSection(ws, workbook, equipment, attachmentLookup, { site, zone, inspection });


  // Végső finomhangolás: magasság a felső sorokra
  /*[1,2,4,5,6,8,9].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = 30;
  });*/

  const identifier =
    buildEquipmentIdentifier(equipment, {
      site,
      zone,
      certificateNo:
        equipment?.certificateNo ||
        equipment?.CertificateNo ||
        certificateNo(equipment) ||
        equipment?.['Declaration of conformity']
    }) ||
    equipment.EqID ||
    inspection.eqId ||
    'unknown';
  const sanitizedIdentifier = sanitizeFileNameSegment(identifier);
  const fileName = isIndexTenant
    ? `Ex ITR - Line ${sanitizedIdentifier}_Inspection_${Date.now()}.xlsx`
    : `${sanitizedIdentifier}_Inspection_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

function normalizeRequestHost(rawHost) {
  const host = String(rawHost || '').split(',')[0].trim().toLowerCase();
  return host.replace(/:\d+$/, '');
}

function isInspExHost(rawHost) {
  const host = normalizeRequestHost(rawHost);
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  return host === 'insp-ex.com' || host.endsWith('.insp-ex.com');
}

function buildProjectExRegisterWorkbook(equipments, {
  zoneMap,
  inspectionById,
  inspectionByEquipment,
  certMap,
  tenantName,
  requestHost
}) {
  const hostBased = isInspExHost(requestHost);
  const tenantSlugRaw = (tenantName || '').toLowerCase().trim();
  const tenantSlug = tenantSlugRaw.replace(/_/g, '-');
  const tenantBasedIsInspEx =
    tenantSlug === 'insp-ex' ||
    tenantSlug === 'inspex' ||
    tenantSlug === 'insp ex';
  const includeUserRequirement = requestHost ? !hostBased : !tenantBasedIsInspEx;

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
    'Certificate No',
    'Certificate Issue Date',
    'Special Condition',
    'Declaration of conformity',
    'Zone',
    'Gas / Dust Group',
    'Temp Rating',
    'Ambient Temp',
    'Inspection Date',
    'Inspector',
    'Type',
    'Status',
    'Remarks'
  ];
  if (includeUserRequirement) {
    headers.splice(
      headers.indexOf('Inspection Date'),
      0,
      'Req Zone',
      'Req Gas / Dust Group',
      'Req Temp Rating',
      'Req Ambient Temp',
      'Req IP Rating'
    );
  }

  worksheet.columns = headers.map(header => ({
    header,
    key: header,
    width: 2
  }));

  worksheet.spliceRows(1, 0, []);
  const groupRow = worksheet.getRow(1);
  const mergeDefs = [
    { start: 1, end: 4, label: 'IDENTIFICATION', color: 'FF00AA00' },
    { start: 5, end: 9, label: 'EQUIPMENT DATA', color: 'FFFF9900' },
    { start: 10, end: 14, label: 'EX DATA', color: 'FF538DD5' },
    { start: 15, end: 18, label: 'CERTIFICATION', color: 'FF00AA00' },
    { start: 19, end: 22, label: 'ZONE REQUIREMENTS', color: 'FFFFFF66' },
    ...(includeUserRequirement
      ? [{ start: 23, end: 27, label: 'USER REQUIREMENT', color: 'FFB1A0C7' }]
      : []),
    {
      start: includeUserRequirement ? 28 : 23,
      end: includeUserRequirement ? 32 : 27,
      label: 'INSPECTION DATA',
      color: 'FFB0B0B0'
    }
  ];

  mergeDefs.forEach(def => {
    worksheet.mergeCells(1, def.start, 1, def.end);
    const cell = groupRow.getCell(def.start);
    cell.value = def.label;
    cell.font = { bold: true, color: { argb: 'FF000000' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: def.color }
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const headerRow = worksheet.getRow(2);
  headerRow.eachCell((cell, colNumber) => {
    let bg = null;
    if (colNumber >= 1 && colNumber <= 4) bg = 'FFCCFFCC';
    else if (colNumber >= 5 && colNumber <= 9) bg = 'FFFFE0B2';
    else if (colNumber >= 10 && colNumber <= 14) bg = 'FFDCE6F1';
    else if (colNumber >= 15 && colNumber <= 18) bg = 'FFCCFFCC';
    else if (colNumber >= 19 && colNumber <= 22) bg = 'FFFFFFCC';
    else if (includeUserRequirement && colNumber >= 23 && colNumber <= 27) bg = 'FFE4DFEC';
    else if (
      (!includeUserRequirement && colNumber >= 23 && colNumber <= 27) ||
      (includeUserRequirement && colNumber >= 28 && colNumber <= 32)
    ) bg = 'FFE0E0E0';

    cell.font = { bold: true, color: { argb: 'FF000000' } };
    if (bg) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
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
    'Status'
  ]);
  if (includeUserRequirement) {
    centerAlignedColumns.add('Req Zone');
    centerAlignedColumns.add('Req Gas / Dust Group');
    centerAlignedColumns.add('Req Temp Rating');
    centerAlignedColumns.add('Req Ambient Temp');
    centerAlignedColumns.add('Req IP Rating');
  }

  let equipmentIndex = 0;
  for (const eq of equipments) {
    equipmentIndex += 1;
    const zone = (eq.Unit || eq.Zone) ? zoneMap.get(String(eq.Unit || eq.Zone)) : null;

    let inspection = null;
    if (eq.lastInspectionId) {
      inspection = inspectionById?.get(eq.lastInspectionId.toString()) || null;
    }
    if (!inspection && inspectionByEquipment) {
      inspection = inspectionByEquipment.get(eq._id?.toString()) || null;
    }

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
    const hasSpecialCondition = !!(cert && (cert.specCondition || cert.xcondition));

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
        'EPL': marking ? (marking['Equipment Protection Level'] || '') : '',
        'SubGroup': marking ? (marking['Gas / Dust Group'] || '') : '',
        'Temperature Class': marking ? (marking['Temperature Class'] || '') : '',
        'Protection Concept': marking ? (marking['Type of Protection'] || '') : '',
        'Certificate No': exportCertNo,
        'Certificate Issue Date': cert?.issueDate || '',
        'Special Condition': hasSpecialCondition ? 'Yes' : 'No',
        'Declaration of conformity': exportDocNo,
        'Zone': zoneNumber,
        'Gas / Dust Group': zoneSubGroup,
        'Temp Rating': zoneTempDisplay,
        'Ambient Temp': ambientDisplay,
        'Status': complianceStatus(eq) || '',
        'Inspection Date': inspectionDate ? new Date(inspectionDate) : '',
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
          cell.font = { color: { argb: complianceColor }, bold: true };
        }

        if (centerAlignedColumns.has(header)) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }
      });

      if (row.number > 2) {
        const isEven = row.number % 2 === 0;
        row.eachCell(cell => {
          if (isEven) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF5F5F5' }
            };
          } else {
            cell.fill = undefined;
          }
        });
      }
    }
  }

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

  return workbook;
}

function buildPunchlistWorkbook({ site, zone, failures, reportDate, scopeLabel }) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Punchlist');

  ws.columns = DEFAULT_COLUMNS;

  applyOnePageWidePrintSetup(ws);

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
    const zoneDisplays = zoneRbDisplays(zone);
    const zoneNumber = zoneDisplays.zoneNumber;
    const zoneSubGroup = zoneDisplays.subGroup;
    const zoneTempDisplay = zoneDisplays.temp;
    const ambientDisplay = zoneDisplays.ambient;
    const zoneIpRating = zoneDisplays.ipRating;
    const zoneEpl = zoneDisplays.epl;

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
    ws.getCell(`L${ar}`).value = zoneIpRating || '';

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
    const noteCellInfo = buildNoteCellValueWithSeverity(item.note, item.severity);
    const rowValues = [];
    rowValues[1] = item.eqId || '';      // A (merged A-B)
    rowValues[3] = item.ref || '';       // C
    rowValues[4] = item.check || '';     // D (merged D-H)
    rowValues[9] = noteCellInfo.value;   // I (merged I-L)
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
    const noteText = noteCellInfo.text || '';
    const imageText = Array.isArray(item.imageNames) ? item.imageNames.join(', ') : '';
    const textLength = Math.max(checkText.length, noteText.length, imageText.length, 1);
    const lineCount = Math.max(1, Math.ceil(textLength / 60));
    ws.getRow(rn).height = lineCount * 15;
  });

  const fileName = `Punchlist_${site?.Name || zone?.Name || 'report'}_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

async function generateProjectReportArchive({ tenantId, siteId, tenantName, requestHost, format = 'xlsx' }, targetStream, progressCb = null) {
  const site = await Site.findOne({ _id: siteId, tenantId }).lean();
  if (!site) {
    throw new Error('Project not found.');
  }

  const equipments = await Dataplate.find({ tenantId, Site: siteId })
    .select(REPORT_EQUIPMENT_SELECT)
    .lean();
  if (!equipments.length) {
    throw new Error('No equipment found for this project.');
  }
  const totalEquipments = equipments.length;
  if (typeof progressCb === 'function') {
    progressCb({ processed: 0, total: totalEquipments });
  }

  const zones = await Zone.find({ tenantId, Site: siteId }).lean();
  const zoneMap = new Map();
  zones.forEach(zone => zoneMap.set(zone._id.toString(), zone));

  const { inspectionByEquipment, inspectionById } = await loadLatestInspectionMapForEquipments(equipments, tenantId);

  const certMap = await buildReportCertificateCache(tenantId, equipments);

  const exWorkbook = buildProjectExRegisterWorkbook(equipments, {
    zoneMap,
    inspectionById,
    inspectionByEquipment,
    certMap,
    tenantName,
    requestHost
  });
  const safeSiteName = sanitizeFileNameSegment(site?.Name || site?.SiteName || 'project');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectExFileName = `Project_ExRegister_${safeSiteName}_${timestamp}.xlsx`;
  const projectExBuffer = await exWorkbook.xlsx.writeBuffer();

  const schemeCache = certMap;
  const projectFailures = [];
  const uniqueCertificateKeys = new Set();

  const { archive, finalized, getByteCount } = setupArchiveStream(targetStream);
  let zipName = `Project_Ex_Report_${safeSiteName}_${timestamp}.zip`;

  archive.append(projectExBuffer, { name: projectExFileName });

  let equipmentIndex = 0;
  let processedEquipments = 0;
  for (const eq of equipments) {
    equipmentIndex++;
    const eqIdStr = eq._id?.toString();
    const inspection =
      (eq.lastInspectionId && inspectionById.get(eq.lastInspectionId.toString())) ||
      inspectionByEquipment.get(eqIdStr);
    if (!inspection) continue;

    const zoneId = (eq.Unit || eq.Zone) ? String(eq.Unit || eq.Zone) : null;
    const zone = zoneId ? zoneMap.get(zoneId) : null;

    const identifier =
      buildEquipmentIdentifier(eq, {
        site,
        zone,
        certificateNo:
          eq?.certificateNo ||
          eq?.CertificateNo ||
          certificateNo(eq) ||
          eq?.['Declaration of conformity']
      }) ||
      eq['EqID'] ||
      inspection.eqId ||
      eqIdStr ||
      `equipment_${projectFailures.length + 1}`;
    const sanitizedIdentifier = sanitizeFileNameSegment(
      identifier || `equipment_${equipmentIndex}`
    );
    const scheme = await resolveSchemeFromEquipment(eq, schemeCache);

    const attachmentLookup = buildInspectionAttachmentLookup(
      inspection,
      eq['EqID'] || inspection.eqId,
      sanitizedIdentifier,
      {
        siteName: site?.Name || site?.SiteName || null,
        zoneName: zone?.Name || zone?.ZoneName || null,
        eqId: eq?.EqID || inspection?.eqId || null
      }
    );

    const { workbook: itrWorkbook, fileName: itrFileName } = await buildInspectionWorkbook(
      inspection,
      eq,
      site,
      zone,
      scheme,
      attachmentLookup,
      { tenantName: tenantName || '' }
    );
    const itrFile = await buildInspectionFileBuffer(itrWorkbook, itrFileName, format);
    archive.append(itrFile.buffer, {
      name: path.posix.join(PROJECT_REPORT_DIRS.INSPECTIONS, itrFile.fileName)
    });

    const equipmentDocs = collectEquipmentDocuments(eq, sanitizedIdentifier, {
      siteName: site?.Name || site?.SiteName || null,
      zoneName: zone?.Name || zone?.ZoneName || null,
      eqId: eq?.EqID || inspection?.eqId || null
    });
    const inspectionDocAttachments = collectInspectionDocumentAttachments(
      inspection,
      sanitizedIdentifier,
      {
        siteName: site?.Name || site?.SiteName || null,
        zoneName: zone?.Name || zone?.ZoneName || null,
        eqId: eq?.EqID || inspection?.eqId || null
      }
    );

    const combinedImages = [
      ...(attachmentLookup?.all || []),
      ...(equipmentDocs.imageMetas || [])
    ];
    if (combinedImages.length) {
      await appendImagesToArchive(archive, combinedImages, PROJECT_REPORT_DIRS.IMAGES);
    }

    const combinedDocs = [
      ...(equipmentDocs.documentMetas || []),
      ...inspectionDocAttachments
    ];
    if (combinedDocs.length) {
      await appendDocumentsToArchive(archive, combinedDocs, PROJECT_REPORT_DIRS.DOCUMENTS);
    }

    const certDoc = resolveCertificateFromCache(certMap, certificateNo(eq));
    const certificateSource =
      certDoc?.fileUrl ||
      certDoc?.sharePointFileUrl ||
      certDoc?.docxUrl ||
      certDoc?.sharePointDocxUrl;
    const certNumberRaw =
      certificateNo(eq) ||
      eq['CertNo'] ||
      eq['certNo'] ||
      eq['certificateNumber'] ||
      certDoc?.CertNo ||
      certDoc?.certNo;
    const normalizedCertKey = (certNumberRaw || '').toString().trim().toUpperCase();
    const certKey = normalizedCertKey || certificateSource || certDoc?._id?.toString();
    if (certificateSource && certKey && !uniqueCertificateKeys.has(certKey)) {
      try {
        const certBuffer = await azureBlob.downloadToBuffer(certificateSource);
        const blobPath = azureBlob.toBlobPath(certificateSource);
        const ext = path.extname(blobPath || '') || '.pdf';
        const certBase =
          normalizedCertKey ||
          sanitizeFileNameSegment(certDoc?.alias || certDoc?.name || sanitizedIdentifier, 'certificate');
        const certFileName = `${sanitizeFileNameSegment(certBase, 'certificate')}${ext}`;
        archive.append(certBuffer, {
          name: path.posix.join(PROJECT_REPORT_DIRS.CERTIFICATES, certFileName)
        });
        uniqueCertificateKeys.add(certKey);
      } catch (err) {
        console.warn('⚠️ Failed to append certificate to project ZIP:', err?.message || err);
      }
    }

    const failedResults = Array.isArray(inspection.results)
      ? inspection.results.filter(r => r.status === 'Failed')
      : [];
    if (failedResults.length) {
      failedResults.forEach(r => {
        const ref = deriveQuestionReference(r);
        const checkText =
          r.questionText?.eng ||
          r.questionText?.hun ||
          r.questionText?.hu ||
          r.question ||
          '';
        const imageNames = attachmentLookup
          ? attachmentLookup.getFileNamesForResult(r)
          : [];
        const failure = {
          eqId: eq['EqID'] || inspection.eqId || sanitizedIdentifier,
          ref,
          check: checkText,
          note: r.note || '',
          severity: r.severity || null,
          imageNames: imageNames || []
        };
        projectFailures.push(failure);
      });
    }
    processedEquipments++;
    if (typeof progressCb === 'function') {
      progressCb({ processed: processedEquipments, total: totalEquipments });
    }
  }

  const { workbook: finalProjectPunchWorkbook } = buildPunchlistWorkbook({
    site,
    zone: null,
    failures: projectFailures,
    reportDate: new Date(),
    scopeLabel: 'Project scope'
  });
  const finalPunchBuffer = await finalProjectPunchWorkbook.xlsx.writeBuffer();
  archive.append(finalPunchBuffer, { name: `Project_Punchlist_${safeSiteName}_${timestamp}.xlsx` });

  await archive.finalize();
  await finalized;

  if (typeof progressCb === 'function') {
    progressCb({ processed: totalEquipments, total: totalEquipments });
  }

  return { zipName, byteCount: getByteCount(), totalEquipments };
}

async function generateLatestInspectionArchive(
  { tenantId, siteId, zoneId, includeImages, tenantName, requestHost, jobId = null, format = 'xlsx' },
  targetStream,
  progressCb = null
) {
  if (!zoneId && !siteId) {
    throw new Error('zoneId or siteId is required');
  }

  const equipmentFilter = { tenantId };
  if (zoneId) {
    await addZoneScopeToEquipmentFilter({ tenantId, zoneId, equipmentFilter, includeDescendants: false });
  }
  if (siteId) equipmentFilter.Site = siteId;

  const equipments = await Dataplate.find(equipmentFilter)
    .select(REPORT_EQUIPMENT_SELECT)
    .lean();
  if (!equipments || equipments.length === 0) {
    throw new Error('No equipment found for the provided scope.');
  }
  const totalEquipments = equipments.length;
  if (typeof progressCb === 'function') {
    progressCb({ processed: 0, total: totalEquipments });
  }

  const site = siteId ? await Site.findById(siteId).lean() : null;
  const zone = zoneId ? await Zone.findById(zoneId).lean() : null;

  const siteCache = new Map();
  const zoneCache = new Map();
  const certificateCache = await buildReportCertificateCache(tenantId, equipments);
  const { inspectionByEquipment } = await loadLatestInspectionMapForEquipments(equipments, tenantId);

  const { archive, finalized, getByteCount } = setupArchiveStream(targetStream);
  let fileCount = 0;

  const safeSite = site ? sanitizeFileNameSegment(site?.Name || site?.SiteName) : null;
  const safeZone = zone ? sanitizeFileNameSegment(zone?.Name || zone?.ZoneName) : null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let zipName = 'inspection-reports.zip';
  if (zoneId && safeZone) {
    zipName = `Zone_${safeZone}_${timestamp}.zip`;
  } else if (siteId && safeSite) {
    zipName = `Project_${safeSite}_${timestamp}.zip`;
  } else {
    zipName = `Inspection_Reports_${timestamp}.zip`;
  }

  let processedEquipments = 0;
  const exportErrors = [];
  for (const equipment of equipments) {
    const equipmentId = objectIdString(equipment?._id);
    const equipmentLabel = equipment?.EqID || equipment?.TagNo || equipmentId || 'unknown-equipment';
    try {
      const inspection = inspectionByEquipment.get(equipmentId);

      if (!inspection) {
        continue;
      }

      const context = await resolveInspectionContext(inspection, {
        equipment,
        siteCache,
        zoneCache,
        certificateCache
      });

      if (context.error) {
        exportErrors.push({ equipmentId, equipmentLabel, error: context.error });
        continue;
      }

      const identifier =
        buildEquipmentIdentifier(context.equipment, {
          site: context.site,
          zone: context.zone,
          certificateNo:
            context.equipment?.certificateNo ||
            context.equipment?.CertificateNo ||
            certificateNo(context.equipment) ||
            context.equipment?.['Declaration of conformity']
        }) ||
        context.equipment?.EqID ||
        inspection.eqId;
      const attachmentLookup = includeImages
        ? buildInspectionAttachmentLookup(
            inspection,
            context.equipment?.EqID || inspection.eqId,
            identifier,
            {
              siteName: context.site?.Name || context.site?.SiteName || null,
              zoneName: context.zone?.Name || context.zone?.ZoneName || null,
              eqId: context.equipment?.EqID || inspection.eqId || null
            }
          )
        : null;

      const { workbook, fileName } = await buildInspectionWorkbook(
        inspection,
        context.equipment,
        context.site,
        context.zone,
        context.scheme,
        attachmentLookup,
        { tenantName: tenantName || '' }
      );
      const exportFile = await buildInspectionFileBuffer(workbook, fileName, format);
      archive.append(exportFile.buffer, { name: exportFile.fileName });
      fileCount++;

      if (includeImages && attachmentLookup?.all?.length) {
        await appendImagesToArchive(archive, attachmentLookup.all);
      }
    } catch (err) {
      const details = errorDetails(err);
      exportErrors.push({ equipmentId, equipmentLabel, error: details.message });
      console.warn(`[report-job ${jobId || 'latest_inspections'}] skipped equipment during ITR export`, {
        equipmentId,
        equipmentLabel,
        error: details.message,
        stack: details.stack
      });
    }

    processedEquipments++;
    if (typeof progressCb === 'function') {
      progressCb({ processed: processedEquipments, total: totalEquipments });
    }
  }

  if (!fileCount) {
    const firstError = exportErrors[0]?.error;
    throw new Error(firstError
      ? `No inspections could be exported. First error: ${firstError}`
      : 'No inspections were found for the selected zone/project.');
  }

  if (exportErrors.length) {
    archive.append(JSON.stringify({
      message: 'Some equipment could not be exported.',
      skippedCount: exportErrors.length,
      skipped: exportErrors
    }, null, 2), { name: 'export-errors.json' });
  }

  await archive.finalize();
  await finalized;

  if (typeof progressCb === 'function') {
    progressCb({ processed: totalEquipments, total: totalEquipments });
  }

  return { zipName, byteCount: getByteCount(), totalEquipments };
}

function buildReportBlobPath(tenantId, jobId) {
  return `${REPORT_BLOB_PREFIX}/${String(tenantId)}/${jobId}.zip`;
}

const reportJobQueue = [];
const queuedReportJobIds = new Set();
let activeReportJobs = 0;
let reportWorkerTimer = null;
let reportWorkerInitialTimer = null;
let reportWorkerRunning = false;
let reportWorkerStopping = false;

function reportBackgroundJobsDisabled() {
  return (
    process.env.DISABLE_BACKGROUND_JOBS === '1' ||
    process.env.DISABLE_BACKGROUND_JOBS === 'true' ||
    process.env.NODE_ENV === 'test'
  );
}

function getReportJobConcurrency() {
  const n = Number(process.env.REPORT_EXPORT_MAX_CONCURRENCY || 2);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 5) : 2;
}

function getReportJobPollMs() {
  const n = Number(process.env.REPORT_EXPORT_WORKER_POLL_MS || 10000);
  return Number.isFinite(n) && n >= 1000 ? Math.min(Math.floor(n), 60000) : 10000;
}

function getReportJobStaleMinutes() {
  const n = Number(process.env.REPORT_EXPORT_STALE_MINUTES || 120);
  return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 120;
}

function getReportJobMaxAttempts() {
  const n = Number(process.env.REPORT_EXPORT_MAX_ATTEMPTS || 2);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 5) : 2;
}

function drainReportJobQueue() {
  if (reportWorkerStopping) return;
  const maxConcurrency = getReportJobConcurrency();
  while (activeReportJobs < maxConcurrency && reportJobQueue.length) {
    const jobId = reportJobQueue.shift();
    queuedReportJobIds.delete(jobId);
    activeReportJobs += 1;
    setImmediate(() => {
      runReportExportJob(jobId)
        .catch(err => {
          console.error('Report export job runner error', err);
        })
        .finally(() => {
          activeReportJobs -= 1;
          drainReportJobQueue();
        });
    });
  }
}

function scheduleReportJob(job) {
  if (reportBackgroundJobsDisabled() || reportWorkerStopping) return;
  if (!job?.jobId) return;
  if (queuedReportJobIds.has(job.jobId)) return;
  queuedReportJobIds.add(job.jobId);
  reportJobQueue.push(job.jobId);
  drainReportJobQueue();
}

async function recoverStaleReportJobs() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - getReportJobStaleMinutes() * 60 * 1000);
  const maxAttempts = getReportJobMaxAttempts();
  const staleJobs = await ReportExportJob.find({
    status: 'running',
    $or: [
      { lastHeartbeatAt: { $lte: staleBefore } },
      { lastHeartbeatAt: null, startedAt: { $lte: staleBefore } }
    ]
  }).select('jobId attempts').limit(50).lean();

  for (const job of staleJobs || []) {
    const attempts = Number(job.attempts || 0);
    if (attempts < maxAttempts) {
      await ReportExportJob.updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            status: 'queued',
            errorMessage: `Retrying stale export job after ${getReportJobStaleMinutes()} minutes without heartbeat.`,
            finishedAt: null
          }
        }
      );
      scheduleReportJob(job);
    } else {
      await ReportExportJob.updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            status: 'failed',
            finishedAt: now,
            errorMessage: `Export job exceeded ${maxAttempts} attempts or ${getReportJobStaleMinutes()} minutes without heartbeat.`
          }
        }
      );
    }
  }
}

async function enqueueQueuedReportJobs(limit = 25) {
  const jobs = await ReportExportJob.find({ status: 'queued' })
    .sort({ createdAt: 1 })
    .select('jobId')
    .limit(limit)
    .lean();
  for (const job of jobs || []) scheduleReportJob(job);
}

async function pollReportExportJobs() {
  if (reportWorkerRunning) return;
  reportWorkerRunning = true;
  try {
    await recoverStaleReportJobs();
    await enqueueQueuedReportJobs();
  } catch (err) {
    console.warn('⚠️ Report export worker poll failed', err?.message || err);
  } finally {
    reportWorkerRunning = false;
  }
}

function startReportExportWorker() {
  if (reportBackgroundJobsDisabled()) return;
  if (reportWorkerTimer) return;
  reportWorkerStopping = false;
  reportWorkerInitialTimer = setTimeout(() => pollReportExportJobs().catch(() => {}), 1500);
  if (typeof reportWorkerInitialTimer.unref === 'function') reportWorkerInitialTimer.unref();
  reportWorkerTimer = setInterval(() => {
    pollReportExportJobs().catch(() => {});
  }, getReportJobPollMs());
  if (typeof reportWorkerTimer.unref === 'function') reportWorkerTimer.unref();
}

exports.startReportExportWorker = startReportExportWorker;

async function stopReportExportWorker({ drainTimeoutMs = 120_000 } = {}) {
  reportWorkerStopping = true;
  if (reportWorkerTimer) clearInterval(reportWorkerTimer);
  if (reportWorkerInitialTimer) clearTimeout(reportWorkerInitialTimer);
  reportWorkerTimer = null;
  reportWorkerInitialTimer = null;
  reportJobQueue.length = 0;
  queuedReportJobIds.clear();
  const deadline = Date.now() + Math.max(0, Number(drainTimeoutMs) || 0);
  while ((reportWorkerRunning || activeReportJobs > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { drained: !reportWorkerRunning && activeReportJobs === 0 };
}

exports.stopReportExportWorker = stopReportExportWorker;

async function runReportExportJob(jobId) {
  const now = new Date();
  const job = await ReportExportJob.findOneAndUpdate(
    { jobId, status: 'queued' },
    {
      $set: {
        status: 'running',
        startedAt: now,
        finishedAt: null,
        errorMessage: '',
        lastHeartbeatAt: now
      },
      $inc: { attempts: 1 }
    },
    { new: true }
  );

  if (!job) return;

  const tenantName = job.meta?.tenantName || '';
  const requestHost = job.meta?.requestHost || '';
  console.info(`[report-job ${job.jobId}] started (${job.type}) for tenant ${job.tenantId}`);
  const blobPath = buildReportBlobPath(job.tenantId, job.jobId);
  const uploadStream = new PassThrough();
  let uploadError = null;
  const uploadPromise = azureBlob
    .uploadStream(blobPath, uploadStream, 'application/zip')
    .catch(err => {
      uploadError = err;
      throw err;
    });

  try {
    let result;
    const progressCallback = createProgressCallback(job);
    if (job.type === REPORT_JOB_TYPES.PROJECT_FULL) {
      result = await generateProjectReportArchive(
        {
          tenantId: job.tenantId,
          siteId: job.params?.siteId,
          tenantName,
          requestHost,
          format: normalizeInspectionExportFormat(job.params?.format)
        },
        uploadStream,
        progressCallback
      );
    } else if (job.type === REPORT_JOB_TYPES.LATEST_INSPECTIONS) {
      result = await generateLatestInspectionArchive(
        {
          tenantId: job.tenantId,
          siteId: job.params?.siteId,
          zoneId: job.params?.zoneId,
          includeImages: job.params?.includeImages !== false,
          tenantName,
          requestHost,
          jobId: job.jobId,
          format: normalizeInspectionExportFormat(job.params?.format)
        },
        uploadStream,
        progressCallback
      );
    } else {
      throw new Error(`Unknown report job type: ${job.type}`);
    }

    await uploadPromise;
    if (uploadError) throw uploadError;

    job.status = 'succeeded';
    job.finishedAt = new Date();
    job.lastHeartbeatAt = new Date();
    job.blobPath = blobPath;
    job.blobSize = result?.byteCount || null;
    if (result?.totalEquipments) {
      job.progress = { processed: result.totalEquipments, total: result.totalEquipments, updatedAt: new Date() };
    }
    job.meta = { ...(job.meta || {}), downloadName: result?.zipName };
    await job.save();
    try {
      console.info(`[report-job ${job.jobId}] completed successfully.`);
      await notifyReportExportReady(job);
    } catch (notifyErr) {
      console.warn('⚠️ Report export notification failed', notifyErr?.message || notifyErr);
    }
  } catch (err) {
    uploadStream.destroy(err);
    try {
      await uploadPromise;
    } catch (_) {}
    job.status = 'failed';
    job.errorMessage = err?.message || 'Report export job failed';
    job.finishedAt = new Date();
    job.lastHeartbeatAt = new Date();
    await job.save();
    if (job.userId) {
      notifyExportJobStatus(job, { status: 'failed' }).catch(notifyErr => {
        console.warn('⚠️ Failed to notify job failure', notifyErr?.message || notifyErr);
      });
    }
    console.error(`[report-job ${jobId}] Report export job failed`, errorDetails(err));
  }
}

async function createReportExportJob({ tenantId, userId, type, params = {}, tenantName = '', meta = {} }) {
  const job = await ReportExportJob.create({
    jobId: `${type}-${Date.now()}-${uuidv4().slice(0, 8)}`,
    tenantId,
    userId,
    type,
    params,
    meta: { tenantName, ...meta }
  });
  scheduleReportJob(job);
  if (job.userId) {
    notifyExportJobStatus(job, { status: 'queued' }).catch(err => {
      console.warn('⚠️ Failed to send queued notification for export job', err?.message || err);
    });
  }
  return job;
}

async function serializeReportJob(job, { includeDownloadUrl = false, downloadUrlTtlSeconds } = {}) {
  if (!job) return null;
  const payload = {
    jobId: job.jobId,
    tenantId: job.tenantId,
    userId: job.userId,
    type: job.type,
    status: job.status,
    params: job.params || {},
    meta: job.meta || {},
    blobSize: job.blobSize || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attempts: Number(job.attempts || 0),
    progress: job.progress || { processed: 0, total: 0, updatedAt: null },
    lastHeartbeatAt: job.lastHeartbeatAt || null,
    errorMessage: job.errorMessage || null
  };

  if (includeDownloadUrl && job.status === 'succeeded' && job.blobPath) {
    try {
      payload.downloadUrl = await azureBlob.getReadSasUrl(job.blobPath, {
        ttlSeconds:
          downloadUrlTtlSeconds ||
          Number(systemSettings.getNumber('REPORT_EXPORT_DOWNLOAD_URL_TTL') || 86400) ||
          600,
        filename: job.meta?.downloadName || `${job.jobId}.zip`,
        contentType: 'application/zip'
      });
    } catch (err) {
      console.warn('⚠️ Failed to build SAS URL for report job', {
        jobId: job.jobId,
        err: err?.message || err
      });
    }
  }
  return payload;
}

async function notifyReportExportReady(job) {
  if (!job) return;
  const userId = job.userId ? job.userId.toString() : null;
  let payload = null;
  try {
    payload = await serializeReportJob(job, {
      includeDownloadUrl: true,
      downloadUrlTtlSeconds: Number(systemSettings.getNumber('REPORT_EXPORT_EMAIL_LINK_TTL') || 86400) || 24 * 60 * 60
    });
  } catch (err) {
    console.warn('⚠️ Failed to serialize report job for notification', err?.message || err);
  }

  const title =
    job.type === REPORT_JOB_TYPES.PROJECT_FULL
      ? 'Project export ZIP ready'
      : 'Inspection export ZIP ready';
  const fileName = job.meta?.downloadName || payload?.meta?.downloadName || job.meta?.siteName || job.meta?.zoneName || 'export.zip';

  if (userId) {
    notifyExportJobStatus(job, {
      status: 'succeeded',
      downloadUrl: payload?.downloadUrl || null
    }).catch(err => {
      console.warn('⚠️ Failed to push notification for export job', err?.message || err);
    });
  }

  if (payload?.downloadUrl && job.userId) {
    try {
      const user = await User.findById(job.userId).select('email firstName lastName').lean();
      if (user?.email) {
        const greetingName = [user.firstName, user.lastName].filter(Boolean).join(' ');
        const tenantName =
          job.meta?.tenantName ||
          job.meta?.tenant?.name ||
          job.meta?.tenant ||
          job.meta?.tenantSlug ||
          job.tenantName;
        const html = mailTemplates.reportExportReadyEmail({
          firstName: user.firstName || greetingName || '',
          lastName: user.lastName || '',
          downloadUrl: payload?.downloadUrl,
          fileName,
          jobId: job.jobId,
          tenantName
        });
        await mailService.sendMail({
          to: user.email,
          subject: title,
          html
        });
      }
    } catch (err) {
      console.warn('⚠️ Failed to send export readiness email', err?.message || err);
    }
  }
}

async function respondJobQueued(_req, res, job) {
  const payload = await serializeReportJob(job, { includeDownloadUrl: false });
  return res.status(202).json({
    message: 'Export job queued',
    job: payload
  });
}

exports.exportInspectionXLSX = async (req, res) => {
  try {
    const { id } = req.params;
    const includeImages = req.query?.includeImages === 'true';
    const format = normalizeInspectionExportFormat(req.query?.format);

    const inspection = await Inspection.findById(id)
      .populate(
        'inspectorId',
        'firstName lastName name position positionInfo signatureBlobUrl signatureBlobPath'
      )
      .lean();

    if (!inspection) {
      return res.status(404).json({ message: 'Inspection not found' });
    }

    const context = await resolveInspectionContext(inspection);

    if (context.error) {
      return res.status(404).json({ message: context.error });
    }

    const eqIdentifier =
      buildEquipmentIdentifier(context.equipment, {
        site: context.site,
        zone: context.zone,
        certificateNo:
          context.equipment?.certificateNo ||
          context.equipment?.CertificateNo ||
          certificateNo(context.equipment) ||
          context.equipment?.['Declaration of conformity']
      }) ||
      context.equipment?.EqID ||
      inspection.eqId ||
      inspection.equipmentId;
    const attachmentLookup = includeImages
      ? buildInspectionAttachmentLookup(
          inspection,
          context.equipment?.EqID || inspection.eqId,
          eqIdentifier,
          {
            siteName: context.site?.Name || context.site?.SiteName || null,
            zoneName: context.zone?.Name || context.zone?.ZoneName || null,
            eqId: context.equipment?.EqID || inspection.eqId || null
          }
        )
      : null;

    const { workbook, fileName } = await buildInspectionWorkbook(
      inspection,
      context.equipment,
      context.site,
      context.zone,
      context.scheme,
      attachmentLookup,
      { tenantName: req.scope?.tenantName || '' }
    );

    const exportFile = await buildInspectionFileBuffer(workbook, fileName, format);

    if (!includeImages) {
      setDownloadHeaders(res, exportFile.fileName, exportFile.contentType);
      res.end(exportFile.buffer);
      return;
    }

    const zipIdentifier = sanitizeFileNameSegment(eqIdentifier);
    const zipName = `Inspection_${zipIdentifier}_${Date.now()}.zip`;

    setDownloadHeaders(res, zipName, 'application/zip');

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
    archive.append(exportFile.buffer, { name: exportFile.fileName });
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
    if (zoneId) {
    await addZoneScopeToEquipmentFilter({ tenantId, zoneId, equipmentFilter, includeDescendants: false });
    }

    const equipments = await Dataplate.find(equipmentFilter)
      .select(REPORT_EQUIPMENT_SELECT)
      .lean();
    if (!equipments || equipments.length === 0) {
      return res.status(404).json({ message: 'Nem található eszköz a megadott szűrővel.' });
    }

    const siteCache = new Map();
    const zoneCache = new Map();
    const certificateCache = await buildReportCertificateCache(tenantId, equipments);
    const failures = [];
    const punchlistImages = [];
    const { inspectionByEquipment } = await loadLatestInspectionMapForEquipments(equipments, tenantId);

    let headerSite = siteId ? await getSiteCached(siteId, siteCache) : null;
    let headerZone = zoneId ? await getZoneCached(zoneId, zoneCache) : null;

    for (const equipment of equipments) {
      const inspection = inspectionByEquipment.get(objectIdString(equipment._id));

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

      const identifier =
        buildEquipmentIdentifier(context.equipment, {
          site: context.site,
          zone: context.zone,
          certificateNo:
            context.equipment?.certificateNo ||
            context.equipment?.CertificateNo ||
            certificateNo(context.equipment) ||
            context.equipment?.['Declaration of conformity']
        }) ||
        context.equipment?.EqID ||
        inspection.eqId;
      const attachmentLookup = includeImages
        ? buildInspectionAttachmentLookup(
            inspection,
            context.equipment?.EqID || inspection.eqId,
            identifier,
            {
              siteName: context.site?.Name || context.site?.SiteName || null,
              zoneName: context.zone?.Name || context.zone?.ZoneName || null,
              eqId: context.equipment?.EqID || inspection.eqId || null
            }
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

        const imageNames = attachmentLookup ? attachmentLookup.getFileNamesForResult(r) : [];

        failures.push({
          eqId: context.equipment?.EqID || equipment.EqID || inspection.eqId,
          ref,
          check: checkText,
          note: r.note || '',
          severity: r.severity || null,
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

exports.exportProjectFullReport = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId;
    const siteId = req.query?.siteId;
    const format = normalizeInspectionExportFormat(req.query?.format);

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenant context.' });
    }

    if (!siteId) {
      return res.status(400).json({ message: 'siteId query param is required.' });
    }

    const site = await Site.findOne({ _id: siteId, tenantId }).select('Name SiteName').lean();
    if (!site) {
      return res.status(404).json({ message: 'Project not found.' });
    }

    const job = await createReportExportJob({
      tenantId,
      userId,
      type: REPORT_JOB_TYPES.PROJECT_FULL,
      params: { siteId, format },
      tenantName: req.scope?.tenantName || '',
      meta: {
        siteName: site?.Name || site?.SiteName || '',
        requestHost: req.get('x-forwarded-host') || req.get('host') || req.hostname || ''
      }
    });

    return respondJobQueued(req, res, job, job.meta?.downloadName || 'project_export.zip');
  } catch (err) {
    console.error('Error queueing project report job:', err);
    return res.status(500).json({ message: 'Failed to queue project report', error: err.message });
  }
};

exports.exportLatestInspectionReportsZip = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId;
    const { zoneId, siteId } = req.query || {};
    const includeImages = (req.query?.includeImages ?? 'true') !== 'false';
    const format = normalizeInspectionExportFormat(req.query?.format);

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!zoneId && !siteId) {
      return res.status(400).json({ message: 'Kérjük adjon meg zoneId vagy siteId paramétert.' });
    }

    const meta = {
      requestHost: req.get('x-forwarded-host') || req.get('host') || req.hostname || ''
    };
    if (siteId) {
      const site = await Site.findOne({ _id: siteId, tenantId }).select('Name SiteName').lean();
      if (!site) {
        return res.status(404).json({ message: 'Project not found for the provided siteId.' });
      }
      meta.siteName = site?.Name || site?.SiteName || '';
    }
    if (zoneId) {
      const zone = await Zone.findOne({ _id: zoneId, tenantId }).select('Name ZoneName').lean();
      if (!zone) {
        return res.status(404).json({ message: 'Zone not found for the provided zoneId.' });
      }
      meta.zoneName = zone?.Name || zone?.ZoneName || '';
    }

    const job = await createReportExportJob({
      tenantId,
      userId,
      type: REPORT_JOB_TYPES.LATEST_INSPECTIONS,
      params: { zoneId, siteId, includeImages, format },
      tenantName: req.scope?.tenantName || '',
      meta
    });

    return respondJobQueued(req, res, job, job.meta?.downloadName || 'inspection_reports.zip');
  } catch (err) {
    console.error('Error queueing inspection ZIP job:', err);
    return res.status(500).json({ message: 'Failed to queue inspection ZIP job', error: err.message });
  }
};

exports.getInspectionExportJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenant context.' });
    }

    const job = await ReportExportJob.findOne({ jobId: req.params.jobId, tenantId }).lean();
    if (!job) {
      return res.status(404).json({ message: 'Export job not found.' });
    }

    const payload = await serializeReportJob(job, { includeDownloadUrl: true });
    return res.json(payload);
  } catch (err) {
    console.error('Error fetching export job status:', err);
    return res.status(500).json({ message: 'Failed to fetch export job status', error: err.message });
  }
};

exports.listInspectionExportJobs = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenant context.' });
    }

    const scope = req.query?.scope === 'tenant' && (req.role === 'Admin' || req.role === 'SuperAdmin')
      ? 'tenant'
      : 'user';
    const includeDownload = req.query?.includeDownloadUrl === 'true';
    const limit = Math.min(Number(req.query?.limit) || 25, 100);
    const statusFilter = req.query?.status;

    const filter = { tenantId };
    if (scope === 'user') {
      filter.userId = userId;
    }
    if (statusFilter) {
      filter.status = statusFilter;
    }

    const jobs = await ReportExportJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const payloads = [];
    for (const job of jobs) {
      const payload = await serializeReportJob(job, { includeDownloadUrl: includeDownload });
      if (payload) payloads.push(payload);
    }

    return res.json({
      scope,
      retentionDays: getReportExportRetentionDays(),
      items: payloads
    });
  } catch (err) {
    console.error('Error listing export jobs:', err);
    return res.status(500).json({ message: 'Failed to list export jobs', error: err.message });
  }
};

exports.deleteInspectionExportJob = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.userId;
    const role = req.role;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenant context.' });
    }

    const job = await ReportExportJob.findOne({ jobId: req.params.jobId, tenantId }).lean();
    if (!job) {
      return res.status(404).json({ message: 'Export job not found.' });
    }

    const isOwner = userId && job.userId && String(job.userId) === String(userId);
    const canManageTenant = role === 'Admin' || role === 'SuperAdmin';
    if (!isOwner && !canManageTenant) {
      return res.status(403).json({ message: 'You are not allowed to delete this export job.' });
    }

    if (job.blobPath) {
      try {
        await azureBlob.deleteFile(job.blobPath);
      } catch (err) {
        console.warn('⚠️ Failed to delete export job blob', err?.message || err);
      }
    }

    await ReportExportJob.deleteOne({ _id: job._id });
    return res.json({ deleted: true, jobId: job.jobId });
  } catch (err) {
    console.error('Error deleting export job:', err);
    return res.status(500).json({ message: 'Failed to delete export job', error: err.message });
  }
};
