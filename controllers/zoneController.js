// controllers/zoneController.js
const Unit = require('../models/unit');
const User = require('../models/user');
const Equipment = require('../models/dataplate');
const Site = require('../models/site');
const mongoose = require('mongoose');
const fs = require('fs');
const azureBlob = require('../services/azureBlobService');
const { recordTombstone } = require('../services/syncTombstoneService');
const xlsx = require('xlsx');
const mime = require('mime-types');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const { computeOperationalSummary, computeMaintenanceSeveritySummary } = require('../services/operationalSummaryService');

// Helper: convert string tenantId to ObjectId safely
const toObjectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);

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
function buildSitePrefix(tenantName, tenantId, siteId) {
  return `${buildTenantRoot(tenantName, tenantId)}/projects/${siteId}`;
}
function buildUnitPrefix(tenantName, tenantId, siteId, unitId) {
  return `${buildSitePrefix(tenantName, tenantId, siteId)}/${unitId}`;
}

function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
}

// HEIC → JPEG konverzió (azonos logika, mint exRegisterController-ben)
async function convertHeicBufferIfNeeded(inputBuffer, originalName, originalMime) {
  if (!inputBuffer) return { buffer: inputBuffer, name: originalName, contentType: originalMime };

  const lowerName = String(originalName || '').toLowerCase();
  const lowerMime = String(originalMime || '').toLowerCase();
  const isHeic =
    lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif') ||
    lowerMime === 'image/heic' ||
    lowerMime === 'image/heif';

  if (!isHeic) {
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }

  try {
    // Közvetlenül heic-convert-et használunk; a sharp HEIC támogatása sok környezetben hiányzik.
    // PNG helyett JPEG-et használunk, mert az fényképeknél sokkal kisebb fájlméretet ad.
    const jpegBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.7
    });
    const newName = originalName.replace(/\.(heic|heif)$/i, '.jpg') || 'image.jpg';
    return { buffer: jpegBuffer, name: newName, contentType: 'image/jpeg' };
  } catch (e) {
    console.warn(
      '⚠️ [zoneController] HEIC → PNG conversion failed in heic-convert, using original buffer:',
      e?.message || e
    );
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }
}

exports.createZone = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
    }

    const createdBy = req.user.id;
    const modifiedBy = req.user.id;

    const {
      IpRating,
      EPL,
      AmbientTempMin,
      AmbientTempMax,
      mobileSync,
      ...rest
    } = req.body || {};

    const parentUnitIdRaw = rest.parentUnitId || rest.parentUnitId === null ? rest.parentUnitId : null;
    const parentUnitId = parentUnitIdRaw ? toObjectId(parentUnitIdRaw) : null;
    const siteIdFromBody = rest.Site ? toObjectId(rest.Site) : null;
    if (rest.Site && !siteIdFromBody) {
      return res.status(400).json({ message: 'Invalid siteId format' });
    }

    let parentUnit = null;
    if (parentUnitId) {
      parentUnit = await Unit.findOne({ _id: parentUnitId, tenantId: tenantObjectId }).select('_id Site ancestors depth');
      if (!parentUnit) {
        return res.status(400).json({ message: 'Parent unit not found' });
      }
      if (siteIdFromBody && String(parentUnit.Site) !== String(siteIdFromBody)) {
        return res.status(400).json({ message: 'Parent unit must belong to the same site' });
      }
    }

    const siteIdFinal = parentUnit ? parentUnit.Site : siteIdFromBody;
    if (!siteIdFinal) {
      return res.status(400).json({ message: 'Missing Site for unit' });
    }

    const tempId = typeof mobileSync?.tempId === 'string' ? mobileSync.tempId.trim() : '';
    if (tempId) {
      const existingByTemp = await Unit.findOne({ tenantId: tenantObjectId, 'mobileSync.tempId': tempId });
      if (existingByTemp) {
        return res.status(200).json({ message: 'Zone already created', zone: existingByTemp });
      }
    }

    const nameKey = typeof Unit.normalizeNameKey === 'function' ? Unit.normalizeNameKey(rest.Name) : '';
    if (nameKey) {
      const existingByName = await Unit.findOne({
        tenantId: tenantObjectId,
        Site: siteIdFinal,
        parentUnitId: parentUnit ? parentUnit._id : null,
        nameKey
      });
      if (existingByName) {
        return res.status(409).json({
          message: 'Unit name already exists under this parent.',
          code: 'UNIT_NAME_CONFLICT',
          existingZone: existingByName
        });
      }
    }

    const unit = new Unit({
      ...rest,
      Site: siteIdFinal,
      parentUnitId: parentUnit ? parentUnit._id : null,
      ancestors: parentUnit ? [...(parentUnit.ancestors || []), parentUnit._id] : [],
      depth: parentUnit ? Number(parentUnit.depth || 0) + 1 : 0,
      IpRating: typeof IpRating === 'string' ? IpRating : '',
      EPL: Array.isArray(EPL) ? EPL : (EPL ? [EPL] : []),
      AmbientTempMin: AmbientTempMin !== undefined && AmbientTempMin !== null
        ? Number(AmbientTempMin)
        : undefined,
      AmbientTempMax: AmbientTempMax !== undefined && AmbientTempMax !== null
        ? Number(AmbientTempMax)
        : undefined,
      mobileSync: tempId
        ? {
            tempId,
            deviceId: typeof mobileSync?.deviceId === 'string' ? mobileSync.deviceId.trim() : undefined,
            createdAt: typeof mobileSync?.createdAt === 'string' || typeof mobileSync?.createdAt === 'number'
              ? new Date(mobileSync.createdAt)
              : new Date()
          }
        : undefined,
      CreatedBy: createdBy,
      ModifiedBy: modifiedBy,
      tenantId: tenantObjectId,
    });

    try {
      await unit.save();
    } catch (e) {
      const err = e;
      const isDup = err && typeof err === 'object' && (err.code === 11000 || err?.name === 'MongoServerError');
      if (isDup) {
        const keyPattern = err?.keyPattern || {};
        const isTempDup = keyPattern['mobileSync.tempId'] || keyPattern['mobileSync.tempId'] === 1;
        const isNameDup = keyPattern['nameKey'] || keyPattern['nameKey'] === 1;

        if (tempId && isTempDup) {
          const existingByTemp = await Unit.findOne({ tenantId: tenantObjectId, 'mobileSync.tempId': tempId });
          if (existingByTemp) return res.status(200).json({ message: 'Zone already created', zone: existingByTemp });
        }

        if (nameKey && isNameDup) {
          const existingByName = await Unit.findOne({
            tenantId: tenantObjectId,
            Site: siteIdFinal,
            parentUnitId: parentUnit ? parentUnit._id : null,
            nameKey
          });
          if (existingByName) {
            return res.status(409).json({
              message: 'Unit name already exists under this parent.',
              code: 'UNIT_NAME_CONFLICT',
              existingZone: existingByName
            });
          }
        }
      }
      throw err;
    }

    // After save, create an empty ".keep" in Azure Blob to represent the zone folder
    const tenantName = req.scope?.tenantName || '';
    const unitPrefix = buildUnitPrefix(tenantName, tenantIdStr, String(siteIdFinal), String(unit._id));
    try {
      await azureBlob.uploadBuffer(`${unitPrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
        metadata: { createdAt: new Date().toISOString(), kind: 'folder-keep' }
      });
    } catch (e) {
      console.warn('⚠️ Could not create .keep blob for zone folder:', e?.message);
    }

    return res.status(201).json({ message: 'Zone created successfully', zone: unit });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getZones = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
    }

    const { siteId } = req.query;

    let query = { tenantId: tenantObjectId };
    if (req.query.updatedSince) {
      const raw = String(req.query.updatedSince).trim();
      const asNum = Number(raw);
      const d = Number.isFinite(asNum) ? new Date(asNum) : new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        query.updatedAt = { $gt: d };
      }
    }
    if (siteId) {
      if (!mongoose.Types.ObjectId.isValid(siteId)) {
        return res.status(400).json({ message: "Invalid siteId format" });
      }
      query.Site = new mongoose.Types.ObjectId(siteId);
    }

    if (req.query.parentUnitId !== undefined) {
      const parentUnitId = String(req.query.parentUnitId || '').trim();
      if (parentUnitId === '') {
        query.parentUnitId = null;
      } else {
        const parentObjectId = toObjectId(parentUnitId);
        if (!parentObjectId) {
          return res.status(400).json({ message: 'Invalid parentUnitId format' });
        }
        query.parentUnitId = parentObjectId;
      }
    }

    const zones = await Unit.find(query).populate('CreatedBy', 'nickname');
    res.status(200).json(zones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getZoneById = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });
    const zone = await Unit.findOne({ _id: req.params.id, tenantId: tenantObjectId }).populate('CreatedBy', 'nickname');
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    res.status(200).json(zone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/zones/:id/operational-summary
exports.getZoneOperationalSummary = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
    }

    const zoneId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(zoneId)) {
      return res.status(400).json({ message: 'Invalid zone id.' });
    }

    const summary = await computeOperationalSummary({
      tenantId: tenantIdStr,
      zoneId
    });

    return res.json({ zoneId, ...summary });
  } catch (error) {
    console.error('❌ getZoneOperationalSummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch zone operational summary.' });
  }
};

// GET /api/zones/:id/maintenance-severity-summary
exports.getZoneMaintenanceSeveritySummary = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
    }

    const zoneId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(zoneId)) {
      return res.status(400).json({ message: 'Invalid zone id.' });
    }

    const summary = await computeMaintenanceSeveritySummary({
      tenantId: tenantIdStr,
      zoneId
    });

    return res.json({ zoneId, ...summary });
  } catch (error) {
    console.error('❌ getZoneMaintenanceSeveritySummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch zone maintenance severity summary.' });
  }
};

exports.updateZone = async (req, res) => {
  try {
    if (req.body.CreatedBy) delete req.body.CreatedBy;
    if (req.body.parentUnitId !== undefined) delete req.body.parentUnitId;
    if (req.body.ancestors !== undefined) delete req.body.ancestors;
    if (req.body.depth !== undefined) delete req.body.depth;

    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });

    const zone = await Unit.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const {
      IpRating,
      EPL,
      AmbientTempMin,
      AmbientTempMax,
      ...restBody
    } = req.body || {};

    Object.assign(zone, restBody);

    if (IpRating !== undefined) {
      zone.IpRating = IpRating;
    }

    if (EPL !== undefined) {
      zone.EPL = Array.isArray(EPL) ? EPL : (EPL ? [EPL] : []);
    }

    if (AmbientTempMin !== undefined) {
      zone.AmbientTempMin = AmbientTempMin !== null ? Number(AmbientTempMin) : undefined;
    }

    if (AmbientTempMax !== undefined) {
      zone.AmbientTempMax = AmbientTempMax !== null ? Number(AmbientTempMax) : undefined;
    }
    zone.ModifiedBy = req.userId;
    await zone.save();
    return res.status(200).json({ message: 'Zone updated successfully', zone });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.moveZone = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });

    const unitId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(unitId)) {
      return res.status(400).json({ message: 'Invalid unit id.' });
    }

    const rawParent = req.body?.newParentUnitId;
    const newParentUnitId = rawParent ? toObjectId(rawParent) : null;
    if (rawParent && !newParentUnitId) {
      return res.status(400).json({ message: 'Invalid newParentUnitId.' });
    }
    if (newParentUnitId && String(newParentUnitId) === String(unitId)) {
      return res.status(400).json({ message: 'Unit cannot be its own parent.' });
    }

    const unit = await Unit.findOne({ _id: unitId, tenantId: tenantObjectId });
    if (!unit) return res.status(404).json({ message: 'Unit not found.' });

    let parentUnit = null;
    if (newParentUnitId) {
      parentUnit = await Unit.findOne({ _id: newParentUnitId, tenantId: tenantObjectId });
      if (!parentUnit) return res.status(400).json({ message: 'Parent unit not found.' });
      if (String(parentUnit.Site) !== String(unit.Site)) {
        return res.status(400).json({ message: 'Parent unit must be in the same site.' });
      }
      if ((parentUnit.ancestors || []).map(String).includes(String(unit._id))) {
        return res.status(400).json({ message: 'Cannot move unit under its own descendant.' });
      }
    }

    const newAncestors = parentUnit ? [...(parentUnit.ancestors || []), parentUnit._id] : [];
    const newDepth = newAncestors.length;
    const oldPrefix = [...(unit.ancestors || []), unit._id].map(String);
    const newPrefix = [...newAncestors, unit._id].map(String);

    const descendants = await Unit.find({ tenantId: tenantObjectId, ancestors: unit._id }).lean();
    const bulkOps = [];

    bulkOps.push({
      updateOne: {
        filter: { _id: unit._id },
        update: {
          $set: {
            parentUnitId: parentUnit ? parentUnit._id : null,
            ancestors: newAncestors,
            depth: newDepth,
            ModifiedBy: req.userId || null
          }
        }
      }
    });

    for (const child of descendants) {
      const anc = (child.ancestors || []).map(String);
      const idx = anc.indexOf(String(unit._id));
      if (idx < 0) continue;
      const tail = anc.slice(idx + 1);
      const merged = newPrefix.concat(tail).map((id) => new mongoose.Types.ObjectId(id));
      bulkOps.push({
        updateOne: {
          filter: { _id: child._id },
          update: { $set: { ancestors: merged, depth: merged.length, ModifiedBy: req.userId || null } }
        }
      });
    }

    if (bulkOps.length) {
      await Unit.bulkWrite(bulkOps);
    }

    return res.status(200).json({ message: 'Unit moved successfully' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to move unit', error: error.message || String(error) });
  }
};

exports.deleteZone = async (req, res) => {
  try {
    const zoneId = req.params.id;
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });

    const zone = await Unit.findOne({ _id: zoneId, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const descendants = await Unit.find({ tenantId: tenantObjectId, ancestors: zone._id }).select('_id').lean();
    const unitIds = [zone._id, ...descendants.map(d => d._id)];

    await Equipment.deleteMany({
      tenantId: tenantObjectId,
      $or: [{ Unit: { $in: unitIds } }, { Zone: { $in: unitIds } }]
    });

    try {
      await recordTombstone({
        tenantId: tenantObjectId,
        entityType: 'zone',
        entityId: zone._id,
        deletedBy: req.userId || null,
        meta: { siteId: zone.Site || null, Name: zone.Name || '' }
      });
    } catch (e) {
      console.warn('⚠️ Failed to write zone tombstone:', e?.message || e);
    }

    const siteIdForPrefix = String(zone.Site || '');
    if (siteIdForPrefix) {
      const zonePrefix = buildUnitPrefix(tenantName, tenantIdStr, siteIdForPrefix, String(zone._id));
      try { await azureBlob.deletePrefix(`${zonePrefix}/`); }
      catch (e) { console.warn('⚠️ zone deletePrefix warning:', e?.message); }
    }

    await Unit.deleteMany({ _id: { $in: unitIds }, tenantId: tenantObjectId });
    return res.status(200).json({ message: 'Zone and related equipment deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// POST /zones/import-xlsx
// XLSX alapú zóna import egy megadott site-hoz
exports.importZonesFromXlsx = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = (req.scope?.tenantName || '').toLowerCase();
    const isIndexTenant = tenantName === 'index' || tenantName === 'ind-ex';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    }

    const file = req.file;
    const siteId = req.body?.siteId || req.query?.siteId;

    if (!file) {
      return res.status(400).json({ message: 'Missing XLSX file (field name: file).' });
    }
    if (!siteId || !mongoose.Types.ObjectId.isValid(siteId)) {
      return res.status(400).json({ message: 'Valid siteId must be provided in the form data or query.' });
    }

    const site = await Site.findOne({ _id: siteId, tenantId: tenantObjectId }).select('Name');
    if (!site) {
      return res.status(404).json({ message: 'Site not found for this tenant.' });
    }

    const workbook = xlsx.readFile(file.path);
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({ message: 'The uploaded workbook does not contain any worksheet.' });
    }
    const sheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ message: 'No data rows found in the uploaded XLSX.' });
    }

    const stats = { created: 0, updated: 0, errors: [] };

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2; // header row assumed at 1

      const name = String(row['Name'] || row['Zone Name'] || '').trim();
      if (!name) {
        stats.errors.push({ row: rowNumber, message: 'Name is required.' });
        continue;
      }

      const description = String(row['Description'] || '').trim();
      const environmentRaw = String(row['Environment'] || '').trim();
      const schemeRaw = String(row['Scheme'] || '').trim();
      const zoneRaw = row['Zone'] ?? row['Zones'] ?? '';
      const subGroupRaw = row['SubGroup'] ?? row['Subgroups'] ?? '';
      const tempClassRaw = String(row['TempClass'] || row['Temp Class'] || '').trim();
      const maxTempRaw = row['MaxTemp'] ?? row['Max Temp'] ?? '';
      const ipRatingRaw = String(row['IpRating'] || row['IP rating'] || '').trim();
      const eplRaw = row['EPL'] ?? '';
      const ambMinRaw = row['AmbientTempMin'] ?? row['Ambient Min'] ?? '';
      const ambMaxRaw = row['AmbientTempMax'] ?? row['Ambient Max'] ?? '';

      const envMap = {
        'gas': 'Gas',
        'g': 'Gas',
        'dust': 'Dust',
        'd': 'Dust',
        'hybrid': 'Hybrid',
        'gd': 'Hybrid',
        'nonex': 'NonEx',
        'non ex': 'NonEx',
        'non-ex': 'NonEx'
      };
      const envKey = environmentRaw.toLowerCase();
      const Environment = envMap[envKey] || 'Gas';

      const schemeMap = {
        'atex': 'ATEX',
        'iecex': 'IECEx',
        'na': 'NA'
      };
      const schemeKey = schemeRaw.toLowerCase();
      const Scheme = schemeMap[schemeKey] || 'ATEX';

      const parseNumberList = (value) => {
        if (Array.isArray(value)) return value.map(Number).filter(v => !Number.isNaN(v));
        const asString = String(value || '').trim();
        if (!asString) return [];
        return asString
          .split(/[;,\/ ]+/)
          .map(v => Number(v.trim()))
          .filter(v => !Number.isNaN(v));
      };

      const parseStringList = (value) => {
        if (Array.isArray(value)) {
          return value
            .map(v => String(v || '').trim())
            .filter(Boolean);
        }
        const asString = String(value || '').trim();
        if (!asString) return [];
        return asString
          .split(/[;,\/ ]+/)
          .map(v => String(v || '').trim())
          .filter(Boolean);
      };

      const parseTempClassSingle = (value) => {
        const asString = String(value || '').trim();
        if (!asString) return undefined;
        const allowed = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
        const candidates = asString
          .split(/[;,\/ ]+/)
          .map(v => String(v || '').trim().toUpperCase())
          .filter(v => allowed.includes(v));
        if (!candidates.length) return undefined;
        // Válasszuk a legszigorúbbat (legalacsonyabb megengedett hőmérsékletet), azaz a legnagyobb T számot
        candidates.sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
        return candidates[candidates.length - 1];
      };

      const ZoneValues = parseNumberList(zoneRaw);
      const SubGroup = parseStringList(subGroupRaw);
      const EPL = parseStringList(eplRaw);

      const TempClass = parseTempClassSingle(tempClassRaw);
      const MaxTemp = maxTempRaw !== '' && maxTempRaw !== null ? Number(maxTempRaw) : undefined;
      const AmbientTempMin = ambMinRaw !== '' && ambMinRaw !== null ? Number(ambMinRaw) : undefined;
      const AmbientTempMax = ambMaxRaw !== '' && ambMaxRaw !== null ? Number(ambMaxRaw) : undefined;
      const IpRating = ipRatingRaw || undefined;

      try {
        const existing = await Unit.findOne({
          tenantId: tenantObjectId,
          Site: site._id,
          Name: name
        });

        const payload = {
          Name: name,
          Description: description || undefined,
          Environment,
          Scheme,
          Zone: ZoneValues,
          SubGroup,
          TempClass,
          MaxTemp,
          IpRating,
          EPL,
          AmbientTempMin,
          AmbientTempMax,
          Site: site._id
        };

        // clientReq csak index tenantnál értelmezett
        if (isIndexTenant) {
          // Optional clientReq* oszlopok
          const crZoneRaw = row['ClientReq Zone'] ?? row['ClientReq Zones'] ?? '';
          const crSubGroupRaw = row['ClientReq SubGroup'] ?? row['ClientReq Subgroups'] ?? '';
          const crTempClassRaw = String(row['ClientReq TempClass'] || row['ClientReq Temp Class'] || '').trim();
          const crMaxTempRaw = row['ClientReq MaxTemp'] ?? row['ClientReq Max Temp'] ?? '';
          const crIpRatingRaw = String(row['ClientReq IpRating'] || row['ClientReq IP rating'] || '').trim();
          const crEplRaw = row['ClientReq EPL'] ?? '';
          const crAmbMinRaw = row['ClientReq AmbientTempMin'] ?? row['ClientReq Ambient Min'] ?? '';
          const crAmbMaxRaw = row['ClientReq AmbientTempMax'] ?? row['ClientReq Ambient Max'] ?? '';

          // clientReq tömb első (opcionális) eleme
          const crZoneValues = parseNumberList(crZoneRaw);
          const crSubGroup = parseStringList(crSubGroupRaw);
          const crEpl = parseStringList(crEplRaw);
          const crTempClass = parseTempClassSingle(crTempClassRaw);
          const crMaxTemp = crMaxTempRaw !== '' && crMaxTempRaw !== null ? Number(crMaxTempRaw) : undefined;
          const crAmbMin = crAmbMinRaw !== '' && crAmbMinRaw !== null ? Number(crAmbMinRaw) : undefined;
          const crAmbMax = crAmbMaxRaw !== '' && crAmbMaxRaw !== null ? Number(crAmbMaxRaw) : undefined;
          const crIpRating = crIpRatingRaw || undefined;

          const hasClientReqData =
            (crZoneValues && crZoneValues.length) ||
            (crSubGroup && crSubGroup.length) ||
            crTempClass ||
            (typeof crMaxTemp === 'number') ||
            crIpRating ||
            (crEpl && crEpl.length) ||
            (typeof crAmbMin === 'number') ||
            (typeof crAmbMax === 'number');

          if (hasClientReqData) {
            payload.clientReq = [{
              Zone: crZoneValues,
              SubGroup: crSubGroup,
              TempClass: crTempClass,
              MaxTemp: crMaxTemp,
              IpRating: crIpRating,
              EPL: crEpl,
              AmbientTempMin: crAmbMin,
              AmbientTempMax: crAmbMax
            }];
          }
        }

        if (existing) {
          Object.assign(existing, payload, { ModifiedBy: req.user?.id || req.userId || null });
          await existing.save();
          stats.updated += 1;
        } else {
          const zone = new Unit({
            ...payload,
            CreatedBy: req.user?.id || req.userId || null,
            ModifiedBy: req.user?.id || req.userId || null,
            tenantId: tenantObjectId
          });
          await zone.save();
          stats.created += 1;
        }
      } catch (e) {
        stats.errors.push({
          row: rowNumber,
          name,
          message: e.message || String(e)
        });
      }
    }

    // Ha volt bármilyen hiba, generáljunk egy válasz XLSX-et a hibákkal
    if (stats.errors.length > 0) {
      try {
        const workbookOut = new ExcelJS.Workbook();
        await workbookOut.xlsx.readFile(file.path);
        const worksheet = workbookOut.worksheets[0];

        const summarySheet = workbookOut.addWorksheet('Import summary');
        summarySheet.addRow(['Created', stats.created]);
        summarySheet.addRow(['Updated', stats.updated]);
        summarySheet.addRow(['Error rows', stats.errors.length]);
        summarySheet.getColumn(1).width = 15;
        summarySheet.getColumn(2).width = 10;

        const errorFill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC0C0' } // halvány piros
        };

        stats.errors.forEach(err => {
          const rowNumber = err.row;
          if (!rowNumber || !worksheet) return;
          const row = worksheet.getRow(rowNumber);
          row.eachCell(cell => {
            cell.fill = errorFill;
          });
          const nameCell = worksheet.getCell(`A${rowNumber}`);
          const existingNote = typeof nameCell.note === 'string' ? nameCell.note + '\n' : '';
          nameCell.note = `${existingNote}${err.message || 'Invalid data in this row.'}`;
        });

        const buffer = await workbookOut.xlsx.writeBuffer();
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="zone-import-errors.xlsx"'
        );
        return res.status(200).send(Buffer.from(buffer));
      } catch (excelErr) {
        console.warn('⚠️ Failed to generate error XLSX for zone import:', excelErr?.message || excelErr);
        // ha az XLSX generálás is elhasal, essünk vissza JSON-re
        return res.status(200).json({
          message: 'Zone import completed with errors.',
          createdCount: stats.created,
          updatedCount: stats.updated,
          issues: stats.errors
        });
      }
    }

    // Ha nem volt hiba, marad a JSON válasz
    return res.status(200).json({
      message: 'Zone import completed.',
      createdCount: stats.created,
      updatedCount: stats.updated,
      issues: []
    });
  } catch (error) {
    console.error('❌ importZonesFromXlsx error:', error);
    return res.status(500).json({ message: 'Failed to import zones from XLSX.', error: error.message || String(error) });
  } finally {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  }
};

exports.uploadFileToZone = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const zone = await Unit.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ message: "Zone not found" });

    const files = req.files || [];
    const aliasFromForm = req.body.alias;
    if (!files.length) {
      return res.status(400).json({ message: "No files provided" });
    }

    const zonePrefix = buildUnitPrefix(tenantName, tenantIdStr, String(zone.Site), String(zone._id));
    const uploadedFiles = [];

    for (const file of files) {
      const safeName = cleanFileName(file.originalname);
      const srcBuffer = fs.readFileSync(file.path);
      const inferredMime = file.mimetype || mime.lookup(safeName) || 'application/octet-stream';
      const { buffer, name: convertedName, contentType } =
        await convertHeicBufferIfNeeded(srcBuffer, safeName, inferredMime);

      const finalName = convertedName;
      const blobPath = `${zonePrefix}/${finalName}`;
      const guessedType = contentType || inferredMime;

      await azureBlob.uploadBuffer(blobPath, buffer, guessedType);

      uploadedFiles.push({
        name: finalName,
        alias: aliasFromForm || finalName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: buffer.length,
        type: (String(guessedType).startsWith('image')) ? 'image' : 'document',
        url: azureBlob.getBlobUrl(blobPath)
      });

      try { fs.unlinkSync(file.path); } catch {}
    }

    zone.documents.push(...uploadedFiles);
    await zone.save();

    // Return the freshly saved docs (with _id-s)
    const savedDocs = zone.documents.slice(-uploadedFiles.length);
    return res.status(200).json({ message: "Files uploaded and saved", files: savedDocs });
  } catch (error) {
    console.error("❌ Multiple file upload error:", error.message || error);
    return res.status(500).json({ message: "Failed to upload files", error: error.message });
  }
};

exports.getFilesOfZone = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    const zone = await Unit.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ message: "Zone not found" });
    res.status(200).json(zone.documents || []);
  } catch (error) {
    res.status(500).json({ message: "Fetch failed", error: error.message });
  }
};

exports.deleteFileFromZone = async (req, res) => {
  try {
    const { zoneId, fileId } = req.params;
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    const zone = await Unit.findOne({ _id: zoneId, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ message: "Zone not found" });

    const fileToDelete = zone.documents.find(doc =>
      doc._id.toString() === fileId || doc.blobPath === fileId || doc.oneDriveId === fileId
    );
    if (!fileToDelete) return res.status(404).json({ message: "File not found" });

    const targetPath = fileToDelete.blobPath || fileToDelete.oneDriveId;
    if (targetPath) {
      try { await azureBlob.deleteFile(targetPath); }
      catch (e) { console.warn('⚠️ Blob delete failed:', e?.message); }
    }

    zone.documents = zone.documents.filter(doc => doc._id.toString() !== fileToDelete._id.toString());
    await zone.save();

    return res.status(200).json({ message: "File deleted" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete", error: error.message });
  }
};

// 🗑️ Összes eszközhöz tartozó kép törlése egy zónán belül
exports.deleteEquipmentImagesInZone = async (req, res) => {
  try {
    const zoneId = req.params.id;
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    }

    const zone = await Unit.findOne({ _id: zoneId, tenantId: tenantObjectId }).select('_id Name');
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found' });
    }

    const equipments = await Equipment.find({
      tenantId: tenantObjectId,
      $or: [{ Unit: zoneId }, { Zone: zoneId }]
    });
    if (!equipments.length) {
      return res.status(200).json({ message: 'No equipment found in this zone.', deletedEquipments: 0, deletedBlobs: 0 });
    }

    const blobPaths = new Set();

    // Gyűjtsük össze az összes képfájlt (Pictures + documents type==='image')
    equipments.forEach(eq => {
      (eq.Pictures || []).forEach(pic => {
        const raw = pic?.blobPath || pic?.blobUrl;
        const p = raw ? azureBlob.toBlobPath(raw) : '';
        if (p) blobPaths.add(p);
      });
      (eq.documents || []).forEach(doc => {
        if (doc && doc.type === 'image') {
          const raw = doc.blobPath || doc.blobUrl;
          const p = raw ? azureBlob.toBlobPath(raw) : '';
          if (p) blobPaths.add(p);
        }
      });
    });

    let deleted = 0;
    for (const p of blobPaths) {
      try {
        await azureBlob.deleteFile(p);
        deleted++;
      } catch (e) {
        try {
          console.warn('⚠️ Failed to delete equipment image blob from zone cleanup:', p, e?.message || e);
        } catch (_) {}
      }
    }

    // Tisztítsuk a DB-t: képek kiürítése az érintett eszközöknél
    for (const eq of equipments) {
      const hasPictures = Array.isArray(eq.Pictures) && eq.Pictures.length;
      const hasImageDocs = Array.isArray(eq.documents) && eq.documents.some(d => d && d.type === 'image');
      if (!hasPictures && !hasImageDocs) continue;

      eq.Pictures = [];
      if (Array.isArray(eq.documents)) {
        eq.documents = eq.documents.filter(d => !d || d.type !== 'image');
      }
      await eq.save();
    }

    return res.status(200).json({
      message: 'All equipment images deleted in zone.',
      deletedEquipments: equipments.length,
      deletedBlobs: deleted
    });
  } catch (error) {
    console.error('❌ deleteEquipmentImagesInZone error:', error);
    return res.status(500).json({ message: 'Failed to delete equipment images in zone', error: error.message || String(error) });
  }
};
