// controllers/zoneController.js
const Zone = require('../models/zone');
const User = require('../models/user');
const Equipment = require('../models/dataplate');
const Site = require('../models/site');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const azureBlob = require('../services/azureBlobService');
const xlsx = require('xlsx');
const mime = require('mime-types');
const ExcelJS = require('exceljs');

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
function buildZonePrefix(tenantName, tenantId, siteName, zoneName) {
  return `${buildTenantRoot(tenantName, tenantId)}/projects/${slug(siteName)}/${slug(zoneName)}`;
}

function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
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
      ...rest
    } = req.body || {};

    const zone = new Zone({
      ...rest,
      IpRating: typeof IpRating === 'string' ? IpRating : '',
      EPL: Array.isArray(EPL) ? EPL : (EPL ? [EPL] : []),
      AmbientTempMin: AmbientTempMin !== undefined && AmbientTempMin !== null
        ? Number(AmbientTempMin)
        : undefined,
      AmbientTempMax: AmbientTempMax !== undefined && AmbientTempMax !== null
        ? Number(AmbientTempMax)
        : undefined,
      CreatedBy: createdBy,
      ModifiedBy: modifiedBy,
      tenantId: tenantObjectId,
    });

    await zone.save();

    // After save, create an empty ".keep" in Azure Blob to represent the zone folder
    const tenantName = req.scope?.tenantName || '';
    // We need the parent site's name to build the path
    const relatedSite = await Site.findOne({ _id: zone.Site, tenantId: tenantObjectId }).select('Name');
    if (!relatedSite) {
      return res.status(400).json({ message: "Related Site not found for this zone" });
    }

    const zonePrefix = buildZonePrefix(tenantName, tenantIdStr, relatedSite.Name, zone.Name);
    try {
      await azureBlob.uploadBuffer(`${zonePrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
        metadata: { createdAt: new Date().toISOString(), kind: 'folder-keep' }
      });
    } catch (e) {
      console.warn('⚠️ Could not create .keep blob for zone folder:', e?.message);
    }

    return res.status(201).json({ message: 'Zone created successfully', zone });
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
    if (siteId) {
      if (!mongoose.Types.ObjectId.isValid(siteId)) {
        return res.status(400).json({ message: "Invalid siteId format" });
      }
      query.Site = new mongoose.Types.ObjectId(siteId);
    }

    const zones = await Zone.find(query).populate('CreatedBy', 'nickname');
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
    const zone = await Zone.findOne({ _id: req.params.id, tenantId: tenantObjectId }).populate('CreatedBy', 'nickname');
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    res.status(200).json(zone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateZone = async (req, res) => {
  try {
    if (req.body.CreatedBy) delete req.body.CreatedBy;

    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });

    const zone = await Zone.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const oldName = zone.Name;
    const newName = req.body.Name;

    // if name changed, move blob folder and contained files (best-effort)
    if (newName && newName !== oldName) {
      // need parent site name to compute prefixes
      const site = await Site.findOne({ _id: zone.Site, tenantId: tenantObjectId }).select('Name');
      if (site) {
        const oldPrefix = buildZonePrefix(tenantName, tenantIdStr, site.Name, oldName);
        const newPrefix = buildZonePrefix(tenantName, tenantIdStr, site.Name, newName);

        try { await azureBlob.renameFile(`${oldPrefix}/.keep`, `${newPrefix}/.keep`); } catch (_) {}

        if (Array.isArray(zone.documents) && zone.documents.length) {
          for (const doc of zone.documents) {
            const legacyPath = doc.oneDriveId || '';
            const currentPath = doc.blobPath || legacyPath || '';
            if (!currentPath || !currentPath.startsWith(oldPrefix + '/')) continue;
            const fileName = path.posix.basename(currentPath);
            const newBlobPath = `${newPrefix}/${fileName}`;
            try {
              await azureBlob.renameFile(currentPath, newBlobPath);
              doc.blobPath = newBlobPath;
              doc.blobUrl  = azureBlob.getBlobUrl(newBlobPath);
              if (doc.oneDriveId) delete doc.oneDriveId;
              if (doc.oneDriveUrl) delete doc.oneDriveUrl;
              if (doc.sharePointId) delete doc.sharePointId;
              if (doc.sharePointUrl) delete doc.sharePointUrl;
            } catch (e) {
              console.warn('⚠️ Zone blob move failed:', currentPath, '→', newBlobPath, e?.message);
            }
          }
        }
      }
    }

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

exports.deleteZone = async (req, res) => {
  try {
    const zoneId = req.params.id;
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ error: 'Invalid or missing tenantId in auth' });

    await Equipment.deleteMany({ Zone: zoneId, tenantId: tenantObjectId });

    const zone = await Zone.findOne({ _id: zoneId, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    // need site name to compute prefix
    const site = await Site.findOne({ _id: zone.Site, tenantId: tenantObjectId }).select('Name');
    if (site) {
      const zonePrefix = buildZonePrefix(tenantName, tenantIdStr, site.Name, zone.Name);
      try { await azureBlob.deletePrefix(`${zonePrefix}/`); }
      catch (e) { console.warn('⚠️ zone deletePrefix warning:', e?.message); }
    }

    await Zone.findOneAndDelete({ _id: zoneId, tenantId: tenantObjectId });
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
        const existing = await Zone.findOne({
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
          const zone = new Zone({
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

    const zone = await Zone.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!zone) return res.status(404).json({ message: "Zone not found" });

    const files = req.files || [];
    const aliasFromForm = req.body.alias;
    if (!files.length) {
      return res.status(400).json({ message: "No files provided" });
    }

    // parent site name to build prefix
    const site = await Site.findOne({ _id: zone.Site, tenantId: tenantObjectId }).select('Name');
    if (!site) return res.status(400).json({ message: "Related Site not found" });

    const zonePrefix = buildZonePrefix(tenantName, tenantIdStr, site.Name, zone.Name);
    const uploadedFiles = [];

    for (const file of files) {
      const safeName = cleanFileName(file.originalname);
      const blobPath = `${zonePrefix}/${safeName}`;
      const guessedType = file.mimetype || mime.lookup(safeName) || 'application/octet-stream';
      await azureBlob.uploadFile(file.path, blobPath, guessedType);

      uploadedFiles.push({
        name: safeName,
        alias: aliasFromForm || safeName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: file.size,
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
    const zone = await Zone.findOne({ _id: req.params.id, tenantId: tenantObjectId });
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
    const zone = await Zone.findOne({ _id: zoneId, tenantId: tenantObjectId });
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
