// controllers/exportInsepctionReport.js

const ExcelJS = require('exceljs');
const archiver = require('archiver');
const path = require('path');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const Inspection = require('../models/inspection');
const Dataplate = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const Certificate = require('../models/certificate');
const User = require('../models/user');
const ReportExportJob = require('../models/reportExportJob');
const azureBlob = require('../services/azureBlobService');
const sharp = require('sharp');
const https = require('https');
const mailService = require('../services/mailService');
const mailTemplates = require('../services/mailTemplates');
const { notifyAndStore } = require('../lib/notifications/notifier');
const {
  buildCertificateCacheForTenant,
  resolveCertificateFromCache
} = require('../helpers/certificateMatchHelper');

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

const INDEX_LOGO_URL = 'https://certs.atexdb.eu/public/index_logo.png';
const REPORT_JOB_TYPES = {
  PROJECT_FULL: 'project_full',
  LATEST_INSPECTIONS: 'latest_inspections'
};
const REPORT_BLOB_PREFIX = 'report-exports';
const REPORT_EXPORT_RETENTION_DAYS =
  Number(process.env.REPORT_EXPORT_RETENTION_DAYS) > 0
    ? Number(process.env.REPORT_EXPORT_RETENTION_DAYS)
    : 90;
const PROJECT_REPORT_DIRS = {
  INSPECTIONS: 'Inspection Reports',
  IMAGES: 'Images',
  DOCUMENTS: 'Documents',
  CERTIFICATES: 'Certificates'
};
const REPORT_PROGRESS_STEP_COUNT = 10;

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
    if (job?.userId) {
      notifyExportJobStatus(job, { status: 'running', processed, total }).catch(err => {
        console.warn('⚠️ Failed to push running status notification', err?.message || err);
      });
    }
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

function buildEquipmentIdentifier(equipment) {
  if (!equipment) return null;

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

function buildInspectionAttachmentLookup(inspection, eqId, identifier = null) {
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

function collectEquipmentDocuments(equipment, eqFolder) {
  const docs = Array.isArray(equipment?.documents) ? equipment.documents : [];
  const documentMetas = [];
  const imageMetas = [];
  docs.forEach((doc, idx) => {
    if (!doc?.blobPath) return;
    const fallback = `doc_${idx + 1}`;
    const meta = normalizeDocumentMeta(doc, eqFolder, fallback, '.bin');
    if (!meta) return;
    if (String(doc.type || '').toLowerCase() === 'image') {
      imageMetas.push(meta);
    } else {
      documentMetas.push(meta);
    }
  });
  return { documentMetas, imageMetas };
}

function collectInspectionDocumentAttachments(inspection, eqFolder) {
  const attachments = Array.isArray(inspection?.attachments) ? inspection.attachments : [];
  const docs = [];
  attachments.forEach((att, idx) => {
    if (!att?.blobPath) return;
    if (att.type && att.type !== 'document') return;
    const fallback = `inspection_doc_${idx + 1}`;
    const meta = normalizeDocumentMeta(att, eqFolder, fallback, '.pdf');
    if (meta) docs.push(meta);
  });
  return docs;
}

async function appendDocumentsToArchive(archive, docs, documentsRoot = 'documents') {
  if (!Array.isArray(docs) || !docs.length) return;
  for (const doc of docs) {
    if (!doc?.blobPath) continue;
    try {
      const buffer = await azureBlob.downloadToBuffer(doc.blobPath);
      const folder = sanitizeFileNameSegment(doc.eqFolder || 'equipment');
      const zipPath = path.posix.join(documentsRoot, folder, doc.fileName);
      archive.append(buffer, { name: zipPath });
    } catch (err) {
      console.error('⚠️ Failed to append document to archive:', err?.message || err);
    }
  }
}

function orderEquipmentPicturesForItr(equipment) {
  const ordered = [];
  const seen = new Set();
  if (!equipment) return ordered;

  const pushUnique = (pic) => {
    if (!pic) return;
    const key = pic.blobPath || pic.blobUrl || pic.fileName || pic._id?.toString();
    if (!key || seen.has(key)) return;
    seen.add(key);
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
    const buffer = await azureBlob.downloadToBuffer(sourcePath);
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

async function appendItrEquipmentImagesSection(ws, workbook, equipment, attachmentLookup) {
  if (!equipment && !attachmentLookup) return;
  const orderedPictures = orderEquipmentPicturesForItr(equipment);
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
    const maxHeightPoints = Math.max(40, ...pair.map(img => (img.heightPx * 72) / 96));
    imageRow.height = maxHeightPoints + 10;

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

  const tenantName = (options.tenantName || '').toLowerCase();
  const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';

  // Oldalbeállítás: 1 oldal szélesre igazítás
  ws.pageSetup = ws.pageSetup || {};
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;   // Szélesség: 1 lap
  ws.pageSetup.fitToHeight = 0;  // Magasság: Automatikus

  // ========= 1. sor – logo (Index) + cím + dátum =========
  if (isIndexTenant) {
    // Logo bal oldalt A1:B2
    try {
      const logoBuffer = await fetchImageBuffer(INDEX_LOGO_URL);
      const imageId = workbook.addImage({
        buffer: logoBuffer,
        extension: 'png'
      });
      // Rögzített méretű logó, hogy az arányai ne torzuljanak
      ws.addImage(imageId, {
        tl: { col: 0, row: 0 },      // A1
        ext: { width: 117.5, height: 53.5 } // px
      });
      ws.mergeCells('A1:B2');
    } catch (e) {
      // ha nem sikerül, csak simán üresen hagyjuk a logó helyét
      ws.mergeCells('A1:B2');
    }

    // Szürke háttér a logo mögötti teljes blokkra (A1:B2)
    ['A','B'].forEach(col => {
      [1,2].forEach(rn => {
        const cell = ws.getCell(`${col}${rn}`);
        cell.fill = HEADER_FILL;
      });
    });

    ws.mergeCells('C1:K2');
    const titleCell = ws.getCell('C1');
    titleCell.value = 'Inspection Test Report';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    // háttér azonos a dátum cellával
    titleCell.fill = HEADER_FILL;
  } else {
    ws.mergeCells('A1:K2');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'Inspection Test Report';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    // háttér azonos a dátum cellával
    titleCell.fill = HEADER_FILL;
  }

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

  // Címsorok magassága – kb. 75%-kal nagyobb a defaultnál
  const headerRowHeight = 15;
  ws.getRow(1).height = headerRowHeight;
  ws.getRow(2).height = headerRowHeight;

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

  await appendItrEquipmentImagesSection(ws, workbook, equipment, attachmentLookup);


  // Végső finomhangolás: magasság a felső sorokra
  /*[1,2,4,5,6,8,9].forEach(rn => {
    const row = ws.getRow(rn);
    row.height = 30;
  });*/

  const identifier =
    buildEquipmentIdentifier(equipment) ||
    equipment.EqID ||
    inspection.eqId ||
    'unknown';
  const fileName = `${sanitizeFileNameSegment(identifier)}_Inspection_${Date.now()}.xlsx`;
  return { workbook, fileName };
}

function buildProjectExRegisterWorkbook(equipments, {
  zoneMap,
  inspectionById,
  inspectionByEquipment,
  certMap
}) {
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

  worksheet.spliceRows(1, 0, []);
  const groupRow = worksheet.getRow(1);
  const mergeDefs = [
    { start: 1, end: 4, label: 'IDENTIFICATION', color: 'FF00AA00' },
    { start: 5, end: 9, label: 'EQUIPMENT DATA', color: 'FFFF9900' },
    { start: 10, end: 14, label: 'EX DATA', color: 'FF538DD5' },
    { start: 15, end: 18, label: 'CERTIFICATION', color: 'FF00AA00' },
    { start: 19, end: 22, label: 'ZONE REQUIREMENTS', color: 'FFFFFF66' },
    { start: 23, end: 27, label: 'USER REQUIREMENT', color: 'FFB1A0C7' },
    { start: 28, end: 32, label: 'INSPECTION DATA', color: 'FFB0B0B0' }
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
    else if (colNumber >= 23 && colNumber <= 27) bg = 'FFE4DFEC';
    else if (colNumber >= 28 && colNumber <= 32) bg = 'FFE0E0E0';

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
    'Req Zone',
    'Req Gas / Dust Group',
    'Req Temp Rating',
    'Req Ambient Temp',
    'Req IP Rating',
    'Status'
  ]);

  let equipmentIndex = 0;
  for (const eq of equipments) {
    equipmentIndex += 1;
    const zone = eq.Zone ? zoneMap.get(eq.Zone.toString()) : null;

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

    const zoneNumber = Array.isArray(zone?.Zone)
      ? zone.Zone.join(', ')
      : (zone?.Zone != null ? String(zone.Zone) : '');
    const zoneSubGroup = Array.isArray(zone?.SubGroup)
      ? zone.SubGroup.join(', ')
      : (zone?.SubGroup != null ? String(zone.SubGroup) : '');

    const zoneTempParts = [];
    if (zone?.TempClass) zoneTempParts.push(zone.TempClass);
    if (typeof zone?.MaxTemp === 'number') zoneTempParts.push(`${zone.MaxTemp}°C`);
    const zoneTempDisplay = zoneTempParts.join(' / ');

    const ambientParts = [];
    if (zone?.AmbientTempMin != null) ambientParts.push(`${zone.AmbientTempMin}°C`);
    if (zone?.AmbientTempMax != null) ambientParts.push(`+${zone.AmbientTempMax}°C`);
    const ambientDisplay = ambientParts.join(' / ');

    const clientReq = Array.isArray(zone?.clientReq) && zone.clientReq.length
      ? zone.clientReq[0]
      : null;
    const clientReqZoneNumber = Array.isArray(clientReq?.Zone)
      ? clientReq.Zone.join(', ')
      : (clientReq?.Zone != null ? String(clientReq.Zone) : '');
    const clientReqGasDustGroup = Array.isArray(clientReq?.SubGroup)
      ? clientReq.SubGroup.join(', ')
      : (clientReq?.SubGroup != null ? String(clientReq.SubGroup) : '');
    const clientReqTempParts = [];
    if (clientReq?.TempClass) clientReqTempParts.push(clientReq.TempClass);
    if (typeof clientReq?.MaxTemp === 'number') clientReqTempParts.push(`${clientReq.MaxTemp}°C`);
    const clientReqTempDisplay = clientReqTempParts.join(' / ');

    const clientReqAmbientParts = [];
    if (clientReq?.AmbientTempMin != null) clientReqAmbientParts.push(`${clientReq.AmbientTempMin}°C`);
    if (clientReq?.AmbientTempMax != null) clientReqAmbientParts.push(`+${clientReq.AmbientTempMax}°C`);
    const clientReqAmbientDisplay = clientReqAmbientParts.join(' / ');
    const clientReqIpRating = clientReq?.IpRating || '';

    const cert = resolveCertificateFromCache(certMap, eq['Certificate No']);
    const hasSpecialCondition = !!(cert && (cert.specCondition || cert.xcondition));

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
        'Req Zone': clientReqZoneNumber,
        'Req Gas / Dust Group': clientReqGasDustGroup,
        'Req Temp Rating': clientReqTempDisplay,
        'Req Ambient Temp': clientReqAmbientDisplay,
        'Req IP Rating': clientReqIpRating,
        'Status': eq['Compliance'] || '',
        'Inspection Date': inspectionDate ? new Date(inspectionDate) : '',
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

  // Oldalbeállítás: 1 oldal szélesre igazítás
  ws.pageSetup = ws.pageSetup || {};
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;   // Szélesség: 1 lap
  ws.pageSetup.fitToHeight = 0;  // Magasság: Automatikus

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

async function generateProjectReportArchive({ tenantId, siteId, tenantName }, targetStream, progressCb = null) {
  const site = await Site.findOne({ _id: siteId }).lean();
  if (!site) {
    throw new Error('Project not found.');
  }

  const equipments = await Dataplate.find({ tenantId, Site: siteId }).lean();
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
  const inspectionById = new Map(inspections.map(i => [i._id.toString(), i]));
  const inspectionByEquipment = new Map();
  equipments.forEach(eq => {
    if (eq.lastInspectionId) {
      const insp = inspectionById.get(eq.lastInspectionId.toString());
      if (insp) {
        inspectionByEquipment.set(eq._id?.toString(), insp);
      }
    }
  });

  const missingEquipments = equipments.filter(
    eq => !inspectionByEquipment.has(eq._id?.toString())
  );
  for (const eq of missingEquipments) {
    const insp = await Inspection.findOne({ equipmentId: eq._id, tenantId })
      .sort({ inspectionDate: -1, createdAt: -1 })
      .populate('inspectorId', 'firstName lastName name')
      .lean();
    if (insp) {
      inspectionByEquipment.set(eq._id.toString(), insp);
      if (insp._id) {
        inspectionById.set(insp._id.toString(), insp);
      }
    }
  }

  let certMap = new Map();
  try {
    certMap = await buildCertificateCacheForTenant(tenantId);
  } catch (err) {
    console.warn('⚠️ Certificate cache build failed for project report:', err?.message || err);
    certMap = new Map();
  }

  const exWorkbook = buildProjectExRegisterWorkbook(equipments, {
    zoneMap,
    inspectionById,
    inspectionByEquipment,
    certMap
  });
  const safeSiteName = sanitizeFileNameSegment(site?.Name || site?.SiteName || 'project');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectExFileName = `Project_ExRegister_${safeSiteName}_${timestamp}.xlsx`;
  const projectExBuffer = await exWorkbook.xlsx.writeBuffer();

  const schemeCache = new Map();
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

    const zoneId = eq.Zone ? eq.Zone.toString() : null;
    const zone = zoneId ? zoneMap.get(zoneId) : null;

    const identifier =
      buildEquipmentIdentifier(eq) ||
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
      sanitizedIdentifier
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
    const itrBuffer = await itrWorkbook.xlsx.writeBuffer();
    archive.append(itrBuffer, {
      name: path.posix.join(PROJECT_REPORT_DIRS.INSPECTIONS, itrFileName)
    });

    const equipmentDocs = collectEquipmentDocuments(eq, sanitizedIdentifier);
    const inspectionDocAttachments = collectInspectionDocumentAttachments(
      inspection,
      sanitizedIdentifier
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

    const certDoc = resolveCertificateFromCache(certMap, eq['Certificate No']);
    const certificateSource =
      certDoc?.fileUrl ||
      certDoc?.sharePointFileUrl ||
      certDoc?.docxUrl ||
      certDoc?.sharePointDocxUrl;
    const certNumberRaw =
      eq['Certificate No'] ||
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

  return { zipName, byteCount: getByteCount() };
}

async function generateLatestInspectionArchive(
  { tenantId, siteId, zoneId, includeImages, tenantName },
  targetStream,
  progressCb = null
) {
  if (!zoneId && !siteId) {
    throw new Error('zoneId or siteId is required');
  }

  const equipmentFilter = { tenantId };
  if (zoneId) equipmentFilter.Zone = zoneId;
  if (siteId) equipmentFilter.Site = siteId;

  const equipments = await Dataplate.find(equipmentFilter).lean();
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
  const certificateCache = new Map();

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

    const identifier =
      buildEquipmentIdentifier(context.equipment) ||
      context.equipment?.EqID ||
      inspection.eqId;
    const attachmentLookup = includeImages
      ? buildInspectionAttachmentLookup(
          inspection,
          context.equipment?.EqID || inspection.eqId,
          identifier
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
    const buffer = await workbook.xlsx.writeBuffer();
    archive.append(buffer, { name: fileName });
    fileCount++;

    if (includeImages && attachmentLookup?.all?.length) {
      await appendImagesToArchive(archive, attachmentLookup.all);
    }
    processedEquipments++;
    if (typeof progressCb === 'function') {
      progressCb({ processed: processedEquipments, total: totalEquipments });
    }
  }

  if (!fileCount) {
    throw new Error('No inspections were found for the selected zone/project.');
  }

  await archive.finalize();
  await finalized;

  if (typeof progressCb === 'function') {
    progressCb({ processed: totalEquipments, total: totalEquipments });
  }

  return { zipName, byteCount: getByteCount() };
}

function buildReportBlobPath(tenantId, jobId) {
  return `${REPORT_BLOB_PREFIX}/${String(tenantId)}/${jobId}.zip`;
}

function scheduleReportJob(job) {
  setImmediate(() => {
    runReportExportJob(job.jobId).catch(err => {
      console.error('Report export job runner error', err);
    });
  });
}

async function runReportExportJob(jobId) {
  const job = await ReportExportJob.findOneAndUpdate(
    { jobId, status: 'queued' },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true }
  );

  if (!job) return;

  const tenantName = job.meta?.tenantName || '';
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
        { tenantId: job.tenantId, siteId: job.params?.siteId, tenantName },
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
          tenantName
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
    job.blobPath = blobPath;
    job.blobSize = result?.byteCount || null;
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
    await job.save();
    if (job.userId) {
      notifyExportJobStatus(job, { status: 'failed' }).catch(notifyErr => {
        console.warn('⚠️ Failed to notify job failure', notifyErr?.message || notifyErr);
      });
    }
    console.error('Report export job failed', { jobId, error: err?.message || err });
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
    errorMessage: job.errorMessage || null
  };

  if (includeDownloadUrl && job.status === 'succeeded' && job.blobPath) {
    try {
      payload.downloadUrl = await azureBlob.getReadSasUrl(job.blobPath, {
        ttlSeconds: downloadUrlTtlSeconds || Number(process.env.REPORT_EXPORT_DOWNLOAD_URL_TTL) || 600,
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
      downloadUrlTtlSeconds: Number(process.env.REPORT_EXPORT_EMAIL_LINK_TTL) || 24 * 60 * 60
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

    const eqIdentifier =
      buildEquipmentIdentifier(context.equipment) ||
      context.equipment?.EqID ||
      inspection.eqId ||
      inspection.equipmentId;
    const attachmentLookup = includeImages
      ? buildInspectionAttachmentLookup(
          inspection,
          context.equipment?.EqID || inspection.eqId,
          eqIdentifier
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

    if (!includeImages) {
      res.setHeader('Content-Type', EXCEL_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const zipIdentifier = sanitizeFileNameSegment(eqIdentifier);
    const zipName = `Inspection_${zipIdentifier}_${Date.now()}.zip`;

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

      const identifier =
        buildEquipmentIdentifier(context.equipment) ||
        context.equipment?.EqID ||
        inspection.eqId;
      const attachmentLookup = includeImages
        ? buildInspectionAttachmentLookup(
            inspection,
            context.equipment?.EqID || inspection.eqId,
            identifier
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

exports.exportProjectFullReport = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId;
    const siteId = req.query?.siteId;

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
      params: { siteId },
      tenantName: req.scope?.tenantName || '',
      meta: {
        siteName: site?.Name || site?.SiteName || ''
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

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!zoneId && !siteId) {
      return res.status(400).json({ message: 'Kérjük adjon meg zoneId vagy siteId paramétert.' });
    }

    const meta = {};
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
      params: { zoneId, siteId, includeImages },
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
      retentionDays: REPORT_EXPORT_RETENTION_DAYS,
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
