const fs = require('fs');
const mime = require('mime-types');
const mongoose = require('mongoose');
const heicConvert = require('heic-convert');

const Equipment = require('../models/dataplate');
const Site = require('../models/site');
const Zone = require('../models/zone');
const ProcessingJob = require('../models/processingJob');
const azureBlob = require('../services/azureBlobService');
const { createEquipmentDataVersion } = require('../services/equipmentVersioningService');
const { normalizeProtectionTypes } = require('../helpers/protectionTypes');
const SyncTombstone = require('../models/syncTombstone');
const { parseSinceDate } = require('../services/syncTombstoneService');

const toObjectId = (value) => {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
};

function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTenantRoot(tenantName, tenantId) {
  const tn = slug(tenantName) || `TENANT_${tenantId}`;
  return `${tn}`;
}

function buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, eqId) {
  const root = buildTenantRoot(tenantName, tenantId);
  if (siteName && zoneName) {
    return `${root}/projects/${slug(siteName)}/${slug(zoneName)}/${slug(eqId)}`;
  }
  return `${root}/equipment/${slug(eqId)}`;
}

function cleanFileName(filename) {
  return String(filename || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
}

function normalizeImageTag(tag, fallback = 'general') {
  const allowed = ['dataplate', 'general', 'fault'];
  const value = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  return allowed.includes(value) ? value : fallback;
}

function normalizeCompliance(value, fallback = 'NA') {
  const allowed = new Set(['NA', 'Passed', 'Failed']);
  const v = typeof value === 'string' ? value.trim() : value;
  if (allowed.has(v)) return v;
  const lower = typeof v === 'string' ? v.toLowerCase() : '';
  if (lower === 'na') return 'NA';
  if (lower.startsWith('pass')) return 'Passed';
  if (lower.startsWith('fail')) return 'Failed';
  return fallback;
}

function normalizeSeverity(input) {
  const raw = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (raw === 'P1' || raw === 'P2' || raw === 'P3' || raw === 'P4') return raw;
  return null;
}

async function getNextOrderIndex(tenantId, siteId = null, zoneId = null) {
  const filter = { tenantId };
  if (siteId) filter.Site = siteId;
  if (zoneId) filter.Zone = zoneId;

  const maxDoc = await Equipment.find(filter).sort({ orderIndex: -1 }).select('orderIndex').limit(1).lean();
  const currentMax =
    Array.isArray(maxDoc) && maxDoc.length
      ? (typeof maxDoc[0].orderIndex === 'number' ? maxDoc[0].orderIndex : 0)
      : 0;
  return (currentMax || 0) + 1;
}

function parseFileKeyFromOriginalName(originalName) {
  const raw = String(originalName || '');
  const idx = raw.indexOf('__');
  if (idx <= 0) return null;
  return raw.slice(0, idx);
}

function stripFileKeyPrefix(originalName) {
  const raw = String(originalName || '');
  const idx = raw.indexOf('__');
  if (idx <= 0) return raw;
  return raw.slice(idx + 2);
}

async function convertHeicBufferIfNeeded(inputBuffer, originalName, originalMime) {
  if (!inputBuffer) return { buffer: inputBuffer, name: originalName, contentType: originalMime };

  const lowerName = String(originalName || '').toLowerCase();
  const lowerMime = String(originalMime || '').toLowerCase();
  const isHeic =
    lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif') ||
    lowerMime === 'image/heic' ||
    lowerMime === 'image/heif';

  if (!isHeic) return { buffer: inputBuffer, name: originalName, contentType: originalMime };

  try {
    const pngBuffer = await heicConvert({ buffer: inputBuffer, format: 'PNG', quality: 1 });
    const newName = originalName.replace(/\.(heic|heif)$/i, '.png') || 'image.png';
    return { buffer: pngBuffer, name: newName, contentType: 'image/png' };
  } catch {
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }
}

// POST /api/mobile/sync
// multipart/form-data:
// - payload: JSON string
// - files[]: each file originalname must be "<fileKey>__<originalName>", where fileKey matches item.tempId
exports.mobileSync = async (req, res) => {
  const tenantIdStr = req.scope?.tenantId;
  const tenantId = toObjectId(tenantIdStr);
  const tenantName = req.scope?.tenantName || '';
  const userId = toObjectId(req.userId);

  if (!tenantId || !userId) {
    return res.status(401).json({ message: 'Missing tenantId or userId from auth.' });
  }

  let payload = null;
  try {
    payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
  } catch {
    return res.status(400).json({ message: 'Invalid payload JSON.' });
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return res.status(400).json({ message: 'payload.items must be a non-empty array.' });
  }

  const files = Array.isArray(req.files) ? req.files : [];

  // Build tag lookup: fileKey -> (cleanOriginalName -> tag)
  const tagLookup = new Map();
  for (const item of items) {
    const fileKey = String(item?.tempId || item?.fileKey || '').trim();
    if (!fileKey) continue;
    const docs = Array.isArray(item?.documents) ? item.documents : Array.isArray(item?.images) ? item.images : [];
    const byName = new Map();
    for (const doc of docs) {
      const name = String(doc?.name || doc?.fileName || '').trim();
      if (!name) continue;
      byName.set(name, normalizeImageTag(doc?.tag, 'general'));
    }
    if (byName.size) tagLookup.set(fileKey, byName);
  }

  // Prefetch sites + zones names for blob paths
  const siteIds = new Set();
  const zoneIds = new Set();
  for (const item of items) {
    const siteId = toObjectId(item?.Site || item?.siteId);
    const zoneId = toObjectId(item?.Zone || item?.zoneId);
    if (siteId) siteIds.add(siteId.toString());
    if (zoneId) zoneIds.add(zoneId.toString());
  }

  const [sites, zones] = await Promise.all([
    Site.find({ _id: { $in: Array.from(siteIds) }, tenantId }).select('_id Name').lean(),
    Zone.find({ _id: { $in: Array.from(zoneIds) }, tenantId }).select('_id Name').lean()
  ]);
  const siteNameById = new Map(sites.map((s) => [String(s._id), s.Name]));
  const zoneNameById = new Map(zones.map((z) => [String(z._id), z.Name]));

  const tempIdToEquipmentId = {};
  // Only newly created equipment should be post-processed (OCR + auto inspection).
  const newlyCreatedEquipmentIds = [];
  const metaByEquipmentId = {};

  for (const item of items) {
    const tempId = String(item?.tempId || '').trim();
    if (!tempId) {
      return res.status(400).json({ message: 'Each item must have a tempId.' });
    }

    const existingEquipmentId = toObjectId(item?.equipmentId || item?.serverId || item?._id);
    const siteId = toObjectId(item?.Site || item?.siteId);
    const zoneId = toObjectId(item?.Zone || item?.zoneId);
    if (!siteId || !zoneId) {
      return res.status(400).json({ message: `Item ${tempId}: missing Site/Zone.` });
    }

    const eqIdRaw = typeof item?.EqID === 'string' ? item.EqID.trim() : '';
    const EqID = eqIdRaw || `MOB_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const compliance = normalizeCompliance(item?.Compliance ?? item?.compliance, 'NA');
    const otherInfo = item?.['Other Info'] ?? item?.otherInfo ?? '';
    const equipmentTypeRaw =
      typeof item?.equipmentType === 'string'
        ? item.equipmentType.trim()
        : typeof item?.['Equipment Type'] === 'string'
          ? item['Equipment Type'].trim()
          : typeof item?.EquipmentType === 'string'
            ? item.EquipmentType.trim()
            : '';
    const failureNote =
      typeof item?.failureNote === 'string'
        ? item.failureNote
        : typeof item?.['Failure Note'] === 'string'
          ? item['Failure Note']
          : '';
    const failureSeverity =
      normalizeSeverity(item?.failureSeverity) ||
      normalizeSeverity(item?.severity) ||
      null;
    const protectionTypesRaw = Array.isArray(item?.protectionTypes) ? item.protectionTypes : null;
    const normalizedProtectionTypes = protectionTypesRaw ? normalizeProtectionTypes(protectionTypesRaw) : [];

    let saved = null;
    if (existingEquipmentId) {
      const existing = await Equipment.findOne({ _id: existingEquipmentId, tenantId });
      if (!existing) {
        return res.status(404).json({ message: `Item ${tempId}: equipment not found for tenant.` });
      }
      const oldSnapshot = existing.toObject({ depopulate: true });
      existing.ModifiedBy = userId;
      existing.Site = siteId;
      existing.Zone = zoneId;
      if (eqIdRaw) existing.EqID = EqID;
      if (equipmentTypeRaw) existing['Equipment Type'] = equipmentTypeRaw;
      existing.Compliance = compliance;
      existing['Other Info'] = otherInfo;
      saved = await existing.save();
      tempIdToEquipmentId[tempId] = String(saved._id);
      try {
        await createEquipmentDataVersion({
          tenantId,
          equipmentId: saved._id,
          changedBy: userId,
          source: 'import',
          oldSnapshot,
          newSnapshot: saved?.toObject?.({ depopulate: true }) || saved,
          ensureBaseline: true
        });
      } catch {}
    } else {
      const equipmentPayload = {
        EqID: EqID,
        Site: siteId,
        Zone: zoneId,
        Compliance: compliance,
        'Other Info': otherInfo,
        isProcessed: false,
        mobileSync: { status: 'queued' },
        CreatedBy: userId,
        ModifiedBy: userId,
        tenantId,
        orderIndex: await getNextOrderIndex(tenantId, siteId, zoneId)
      };
      if (equipmentTypeRaw) equipmentPayload['Equipment Type'] = equipmentTypeRaw;

      const equipmentDoc = new Equipment(equipmentPayload);

      saved = await equipmentDoc.save();
      newlyCreatedEquipmentIds.push(saved._id);
      tempIdToEquipmentId[tempId] = String(saved._id);
      if (failureNote || failureSeverity) {
        metaByEquipmentId[String(saved._id)] = {
          ...(failureNote ? { failureNote } : {}),
          ...(failureSeverity ? { failureSeverity } : {})
        };
      }

      try {
        await createEquipmentDataVersion({
          tenantId,
          equipmentId: saved._id,
          changedBy: userId,
          source: 'create',
          oldSnapshot: {},
          newSnapshot: saved?.toObject?.({ depopulate: true }) || saved,
          ensureBaseline: false
        });
      } catch {}
    }

    // Manual protection selection from mobile (applies to existing + new).
    // If empty, we leave it untouched (OCR may fill for newly created equipment later).
    if (normalizedProtectionTypes.length && saved) {
      try {
        const marks = Array.isArray(saved['Ex Marking']) ? saved['Ex Marking'] : [];
        if (!marks.length) marks.push({});
        marks[0] = { ...(marks[0] || {}), 'Type of Protection': normalizedProtectionTypes.join('; ') };
        saved['Ex Marking'] = marks;
        await saved.save();
      } catch {
        // ignore
      }
    }

    // Attach files that belong to this tempId
    const matchingFiles = files.filter((f) => parseFileKeyFromOriginalName(f.originalname) === tempId);
    if (!matchingFiles.length) continue;

    const siteName = siteNameById.get(String(siteId)) || `Site_${siteId}`;
    const zoneName = zoneNameById.get(String(zoneId)) || `Zone_${zoneId}`;
    const eqIdForPrefix = saved.EqID || EqID;
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantIdStr, siteName, zoneName, eqIdForPrefix);

    for (const file of matchingFiles) {
      const safeOriginalName = cleanFileName(stripFileKeyPrefix(file.originalname));
      const buf = fs.readFileSync(file.path);
      const { buffer, name: convertedName, contentType } = await convertHeicBufferIfNeeded(
        buf,
        safeOriginalName,
        file.mimetype || mime.lookup(safeOriginalName) || 'application/octet-stream'
      );

      const cleanName = convertedName || safeOriginalName || 'image';
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = contentType || 'application/octet-stream';
      await azureBlob.uploadBuffer(blobPath, buffer, guessedType);

      const perItemTagMap = tagLookup.get(tempId) || null;
      const tagFromPayload = perItemTagMap ? perItemTagMap.get(cleanName) || perItemTagMap.get(safeOriginalName) : null;
      const tag = normalizeImageTag(tagFromPayload, 'general');

      saved.documents = [
        ...(saved.documents || []),
        {
          name: cleanName,
          alias: '',
          type: 'image',
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: buffer.length,
          uploadedAt: new Date(),
          tag
        }
      ];
      try {
        fs.unlinkSync(file.path);
      } catch {}
    }

    await saved.save();
  }

  const totalToProcess = newlyCreatedEquipmentIds.length;
  const job =
    totalToProcess > 0
      ? await ProcessingJob.create({
          tenantId,
          createdBy: userId,
          type: 'mobileSync',
          status: 'queued',
          total: totalToProcess,
          processed: 0,
          equipmentIds: newlyCreatedEquipmentIds,
          metaByEquipmentId
        })
      : await ProcessingJob.create({
          tenantId,
          createdBy: userId,
          type: 'mobileSync',
          status: 'done',
          total: 0,
          processed: 0,
          equipmentIds: [],
          startedAt: new Date(),
          finishedAt: new Date()
        });

  // Attach jobId to newly created equipment for traceability.
  if (totalToProcess > 0) {
    try {
      await Equipment.updateMany(
        { _id: { $in: newlyCreatedEquipmentIds }, tenantId },
        { $set: { 'mobileSync.jobId': String(job._id), 'mobileSync.status': 'queued', isProcessed: false } }
      );
    } catch {
      // ignore
    }
  }

  return res.status(201).json({
    jobId: String(job._id),
    map: tempIdToEquipmentId
  });
};

// GET /api/mobile/deletions?since=<iso|ms>&types=site,zone,equipment&zoneId=<id>
// Returns tombstone ids so the mobile client can remove deleted entities from local cache.
exports.getMobileDeletions = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantId = toObjectId(tenantIdStr);
    if (!tenantId) {
      return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    }

    const since = parseSinceDate(req.query.since);
    if (!since) {
      return res.status(400).json({ message: 'since query param is required (ISO date or ms timestamp).' });
    }

    const rawTypes = typeof req.query.types === 'string' ? req.query.types : '';
    const requested = rawTypes
      ? rawTypes.split(',').map((s) => s.trim()).filter(Boolean)
      : ['site', 'zone', 'equipment'];

    const allowed = new Set(['site', 'zone', 'equipment']);
    const types = requested.filter((t) => allowed.has(t));
    if (!types.length) {
      return res.json({ sites: [], zones: [], equipment: [] });
    }

    const zoneId = typeof req.query.zoneId === 'string' ? req.query.zoneId.trim() : '';

    const docs = await SyncTombstone.find({
      tenantId,
      entityType: { $in: types },
      deletedAt: { $gt: since }
    })
      .select('entityType entityId meta deletedAt')
      .lean();

    const result = { sites: [], zones: [], equipment: [] };
    for (const d of docs || []) {
      const type = d?.entityType;
      const idStr = d?.entityId ? String(d.entityId) : '';
      if (!type || !idStr) continue;

      if (type === 'equipment' && zoneId) {
        const z = d?.meta?.zoneId ? String(d.meta.zoneId) : '';
        if (z && z !== zoneId) continue;
      }

      if (type === 'site') result.sites.push(idStr);
      if (type === 'zone') result.zones.push(idStr);
      if (type === 'equipment') result.equipment.push(idStr);
    }

    // Deduplicate
    result.sites = Array.from(new Set(result.sites));
    result.zones = Array.from(new Set(result.zones));
    result.equipment = Array.from(new Set(result.equipment));

    return res.json(result);
  } catch (error) {
    console.error('❌ getMobileDeletions failed:', error);
    return res.status(500).json({ message: 'Failed to load deletions.' });
  }
};

// GET /api/mobile/sync/:jobId/status
exports.getMobileSyncStatus = async (req, res) => {
  const tenantIdStr = req.scope?.tenantId;
  const tenantId = toObjectId(tenantIdStr);
  if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

  const jobId = toObjectId(req.params.jobId);
  if (!jobId) return res.status(400).json({ message: 'Invalid jobId.' });

  const job = await ProcessingJob.findOne({ _id: jobId, tenantId })
    .select('status total processed startedAt finishedAt errorItems createdAt updatedAt')
    .lean();
  if (!job) return res.status(404).json({ message: 'Job not found.' });

  return res.json(job);
};
