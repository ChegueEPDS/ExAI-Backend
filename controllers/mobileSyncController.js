const fs = require('fs');
const mime = require('mime-types');
const mongoose = require('mongoose');
const heicConvert = require('heic-convert');

const Equipment = require('../models/dataplate');
const Site = require('../models/site');
const Unit = require('../models/unit');
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

function buildEquipmentPrefix(tenantName, tenantId, siteId, unitId, eqId) {
  const root = buildTenantRoot(tenantName, tenantId);
  if (siteId && unitId) {
    return `${root}/projects/${siteId}/${unitId}/${slug(eqId)}`;
  }
  return `${root}/equipment/${slug(eqId)}`;
}

function cleanFileName(filename) {
  return String(filename || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
}

function normalizeNameKey(name) {
  const raw = String(name || '').trim();
  const cleaned = cleanFileName(raw).trim();
  return {
    raw,
    cleaned,
    rawLower: raw.toLowerCase(),
    cleanedLower: cleaned.toLowerCase()
  };
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
  if (zoneId) filter.$or = [{ Unit: zoneId }, { Zone: zoneId }];

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
  const startedAt = Date.now();
  const tenantIdStr = req.scope?.tenantId;
  const tenantId = toObjectId(tenantIdStr);
  const tenantName = req.scope?.tenantName || '';
  const userId = toObjectId(req.userId);

  if (!tenantId || !userId) {
    return res.status(401).json({ message: 'Missing tenantId or userId from auth.' });
  }

  try {
    console.info('[mobile-sync] request', {
      requestId: req.requestId || null,
      tenantId: tenantIdStr,
      userId: String(userId),
      ip: req.ip || null
    });
  } catch {}

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

  // Build tag lookup: fileKey -> (name variants -> tag)
  const tagLookup = new Map();
  for (const item of items) {
    const fileKey = String(item?.tempId || item?.fileKey || '').trim();
    if (!fileKey) continue;
    const docs = Array.isArray(item?.documents) ? item.documents : Array.isArray(item?.images) ? item.images : [];
    const byName = new Map();
    let sawDataplate = false;
    for (const doc of docs) {
      const name = String(doc?.name || doc?.fileName || '').trim();
      if (!name) continue;
      const normalized = normalizeImageTag(doc?.tag, 'general');
      // Enforce at most one dataplate tag per equipment in the sync payload.
      // This makes server-side selection deterministic and prevents "random" OCR quality swings.
      const tag = normalized === 'dataplate' && sawDataplate ? 'general' : normalized;
      if (tag === 'dataplate') sawDataplate = true;
      const key = normalizeNameKey(name);
      byName.set(key.raw, tag);
      byName.set(key.cleaned, tag);
      byName.set(key.rawLower, tag);
      byName.set(key.cleanedLower, tag);
    }
    if (byName.size) tagLookup.set(fileKey, byName);
  }

  // Prefetch sites + zones names for blob paths
  const siteIds = new Set();
  const zoneIds = new Set();
  for (const item of items) {
    const siteId = toObjectId(item?.Site || item?.siteId);
    const zoneId = toObjectId(item?.Unit || item?.unitId || item?.Zone || item?.zoneId);
    if (siteId) siteIds.add(siteId.toString());
    if (zoneId) zoneIds.add(zoneId.toString());
  }

  await Promise.all([
    Site.find({ _id: { $in: Array.from(siteIds) }, tenantId }).select('_id').lean(),
    Unit.find({ _id: { $in: Array.from(zoneIds) }, tenantId }).select('_id').lean()
  ]);

  const tempIdToEquipmentId = {};
  // Only newly created equipment should be post-processed (OCR + auto inspection).
  const newlyCreatedEquipmentIds = [];
  const metaByEquipmentId = {};

  for (const item of items) {
    const tempId = String(item?.tempId || '').trim();
    if (!tempId) {
      return res.status(400).json({ message: 'Each item must have a tempId.' });
    }

    let existingEquipmentId = toObjectId(item?.equipmentId || item?.serverId || item?._id);
    if (!existingEquipmentId) {
      // Best-effort idempotency: if the client retries the same tempId after a network failure,
      // re-use the already created equipment instead of creating duplicates.
      try {
        const existingByTemp = await Equipment.findOne({
          tenantId,
          CreatedBy: userId,
          'mobileSync.tempId': tempId
        }).select('_id').lean();
        if (existingByTemp?._id) existingEquipmentId = toObjectId(existingByTemp._id);
      } catch {
        // ignore lookup failures
      }
    }
    const siteId = toObjectId(item?.Site || item?.siteId);
    const zoneId = toObjectId(item?.Unit || item?.unitId || item?.Zone || item?.zoneId);
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

    // Optional: manual overrides from mobile "Edit all data".
    const manual = item?.manual && typeof item.manual === 'object' ? item.manual : null;
    const manualFields = manual?.fields && typeof manual.fields === 'object' ? manual.fields : null;
    const manualExMarking = manual?.exMarking && typeof manual.exMarking === 'object' ? manual.exMarking : null;

    const hasOwn = (obj, key) => !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
    const pickManualString = (obj, key) => {
      if (!hasOwn(obj, key)) return { present: false, value: '' };
      return { present: true, value: String(obj[key] ?? '').trim() };
    };

    const allowedFieldKeys = [
      'TagNo',
      'Manufacturer',
      'Model/Type',
      'Serial Number',
      'Certificate No',
      'IP rating',
      'Max Ambient Temp'
    ];
    const allowedExKeys = [
      'Marking',
      'Equipment Group',
      'Equipment Category',
      'Environment',
      'Gas / Dust Group',
      'Temperature Class',
      'Equipment Protection Level'
    ];

    const exUpdates = {};
    for (const k of allowedExKeys) {
      const { present, value } = pickManualString(manualExMarking, k);
      if (present) exUpdates[k] = value;
    }

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
      existing.Unit = zoneId;
      if (!existing.mobileSync || typeof existing.mobileSync !== 'object') existing.mobileSync = {};
      if (!existing.mobileSync.tempId) existing.mobileSync.tempId = tempId;
      if (eqIdRaw) existing.EqID = EqID;
      if (equipmentTypeRaw) existing['Equipment Type'] = equipmentTypeRaw;
      existing.Compliance = compliance;
      existing['Other Info'] = otherInfo;

      // Apply manual field edits (including clearing to '').
      for (const k of allowedFieldKeys) {
        const { present, value } = pickManualString(manualFields, k);
        if (!present) continue;
        if (existing.set) existing.set(k, value);
        else existing[k] = value;
      }

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
        Unit: zoneId,
        Compliance: compliance,
        'Other Info': otherInfo,
        isProcessed: false,
        mobileSync: { status: 'queued', tempId },
        CreatedBy: userId,
        ModifiedBy: userId,
        tenantId,
        orderIndex: await getNextOrderIndex(tenantId, siteId, zoneId)
      };
      if (equipmentTypeRaw) equipmentPayload['Equipment Type'] = equipmentTypeRaw;

      // Apply manual field edits (including clearing to '').
      for (const k of allowedFieldKeys) {
        const { present, value } = pickManualString(manualFields, k);
        if (!present) continue;
        equipmentPayload[k] = value;
      }

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
    if ((normalizedProtectionTypes.length || Object.keys(exUpdates).length) && saved) {
      try {
        const marks = Array.isArray(saved['Ex Marking']) ? saved['Ex Marking'] : [];
        if (!marks.length) marks.push({});
        const first = marks[0] && typeof marks[0] === 'object' ? marks[0] : {};
        const nextFirst = { ...(first || {}) };
        if (Object.keys(exUpdates).length) {
          Object.keys(exUpdates).forEach((k) => {
            nextFirst[k] = exUpdates[k];
          });
        }
        if (normalizedProtectionTypes.length) {
          nextFirst['Type of Protection'] = normalizedProtectionTypes.join('; ');
        }
        marks[0] = nextFirst;
        saved['Ex Marking'] = marks;
        if (saved.markModified) saved.markModified('Ex Marking');
        await saved.save();
      } catch {
        // ignore
      }
    }

    // Attach files that belong to this tempId
    const matchingFiles = files.filter((f) => parseFileKeyFromOriginalName(f.originalname) === tempId);
    if (!matchingFiles.length) continue;

    const eqIdForPrefix = saved.EqID || EqID;
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantIdStr, String(siteId), String(zoneId), eqIdForPrefix);

    let attachedDataplate = false;
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
      const alreadyHas = (saved.documents || []).some((d) => {
        const n = String(d?.name || '');
        const p = String(d?.blobPath || d?.blobUrl || '');
        return (n && n === cleanName) || (p && azureBlob.toBlobPath(p) === azureBlob.toBlobPath(blobPath));
      });
      if (!alreadyHas) {
        await azureBlob.uploadBuffer(blobPath, buffer, guessedType);
      }

      const perItemTagMap = tagLookup.get(tempId) || null;
      const lookupKeys = [
        normalizeNameKey(cleanName).raw,
        normalizeNameKey(cleanName).cleaned,
        normalizeNameKey(cleanName).rawLower,
        normalizeNameKey(cleanName).cleanedLower,
        normalizeNameKey(safeOriginalName).raw,
        normalizeNameKey(safeOriginalName).cleaned,
        normalizeNameKey(safeOriginalName).rawLower,
        normalizeNameKey(safeOriginalName).cleanedLower
      ];
      const tagFromPayload = perItemTagMap
        ? lookupKeys.map((k) => perItemTagMap.get(k)).find((v) => typeof v === 'string' && v.trim())
        : null;
      let tag = normalizeImageTag(tagFromPayload, 'general');
      if (tag === 'dataplate') {
        if (attachedDataplate) tag = 'general';
        else attachedDataplate = true;
      }

      if (alreadyHas) {
        // Best-effort: if this is a retry and the tag became known later (e.g. filename normalization),
        // update the existing doc tag (without duplicating the blob).
        try {
          const idx = (saved.documents || []).findIndex((d) => String(d?.name || '') === cleanName);
          if (idx >= 0 && tag && saved.documents[idx] && saved.documents[idx].tag !== tag) {
            saved.documents[idx].tag = tag;
            if (saved.markModified) saved.markModified('documents');
          }
        } catch {
          // ignore
        }
      } else {
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
      }
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
