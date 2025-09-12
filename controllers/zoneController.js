// controllers/zoneController.js
const Zone = require('../models/zone');
const User = require('../models/user');
const Equipment = require('../models/dataplate');
const Site = require('../models/site');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const azureBlob = require('../services/azureBlobService');
const mime = require('mime-types');

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

    const zone = new Zone({
      ...req.body,
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

    Object.assign(zone, req.body);
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
