// controllers/siteController.js
const Site = require('../models/site'); // Importáljuk a Site modellt
const User = require('../models/user'); // Importáljuk a User modellt
const Zone = require('../models/zone'); // Ez kell a file tetejére is
const Equipment = require('../models/dataplate'); // 👈 importáljuk a modell tetején
// LEGACY (OneDrive/SharePoint) — kept for reference:
// const { getOrCreateFolder, deleteOneDriveItemById } = require('../controllers/graphController');
const azureBlob = require('../services/azureBlobService');
const { computeOperationalSummary, computeOverallStatusSummary, computeMaintenanceSeveritySummary } = require('../services/operationalSummaryService');
const path = require('path');
const mongoose = require('mongoose');
const fs = require('fs');
const mime = require('mime-types');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const { recordTombstone } = require('../services/syncTombstoneService');

// LEGACY: const axios = require('axios');

// Helper: convert string to ObjectId safely
const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;

function cleanFileName(filename) {
    return filename
      .normalize("NFKD")                         // Szétbontott ékezetek eltávolítása
      .replace(/[\u0300-\u036f]/g, "")           // Diakritikus jelek eltávolítása
      .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");       // Biztonságos karakterek megtartása
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
    // PNG helyett JPEG-et használunk, mert az fényképeknél sokkal kisebb fájlméretet ad
    // és online/PDF megjelenítésre tipikusan ez az optimális.
    const jpegBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      // 0–1 skálán: ~0.7 jó kompromisszum minőség/méret között
      quality: 0.7
    });
    const newName = originalName.replace(/\.(heic|heif)$/i, '.jpg') || 'image.jpg';
    return { buffer: jpegBuffer, name: newName, contentType: 'image/jpeg' };
  } catch (e) {
    console.warn(
      '⚠️ [siteController] HEIC → PNG conversion failed in heic-convert, using original buffer:',
      e?.message || e
    );
    return { buffer: inputBuffer, name: originalName, contentType: originalMime };
  }
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
function buildSitePrefix(tenantName, tenantId, siteId) {
  return `${buildTenantRoot(tenantName, tenantId)}/projects/${siteId}`;
}

// 🔹 Új site létrehozása
exports.createSite = async (req, res) => {
  try {
    const CreatedBy = req.userId;
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) {
      return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
    }

    if (!req.body?.Name) {
      return res.status(400).json({ message: "Site Name is required" });
    }

    // 1) Site létrehozása és mentése
    const newSite = new Site({
      Name: req.body.Name,
      Client: req.body.Client,
      Note: req.body.Note,
      CreatedBy: CreatedBy,
      tenantId: tenantObjectId,
    });
    await newSite.save();

    // 2) Azure Blob „mappa” létrehozása (.keep üres blob)
    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, String(newSite._id));
    try {
      await azureBlob.uploadBuffer(`${sitePrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
        metadata: { createdAt: new Date().toISOString(), kind: 'folder-keep' }
      });
    } catch (e) {
      console.warn('⚠️ Could not create .keep blob for site folder:', e?.message);
    }
    // store site blob prefix for convenience
    try {
      newSite.blobPrefix = sitePrefix;
      await newSite.save();
    } catch (e) {
      console.warn('⚠️ Could not persist blobPrefix on site:', e?.message);
    }

    // LEGACY (OneDrive + SharePoint) — removed in favor of Azure Blob:
    /*
    const user = await User.findById(CreatedBy);
    const hasEntraID = !!user?.tenantId;
    const accessToken = req.headers['x-ms-graph-token'];
    if (hasEntraID && accessToken) {
      const oneDrivePath = `ExAI/Projects/${newSite.Name}`;
      const tenantLabel = `TENANT_${tenantIdStr}`.toUpperCase();
      const sharePointPath = `${tenantLabel}/Projects/${newSite.Name}`;
      const folderResult = await getOrCreateFolder(accessToken, oneDrivePath);
      if (folderResult?.folderId) {
        newSite.oneDriveFolderUrl = folderResult.folderUrl;
        newSite.oneDriveFolderId = folderResult.folderId;
      }
      const { getOrCreateSharePointFolder } = require('../helpers/sharePointHelpers');
      const spFolderResult = await getOrCreateSharePointFolder(accessToken, sharePointPath);
      if (spFolderResult?.folderId) {
        newSite.sharePointFolderUrl = spFolderResult.folderUrl;
        newSite.sharePointFolderId = spFolderResult.folderId;
        newSite.sharePointSiteId = spFolderResult.siteId;
        newSite.sharePointDriveId = spFolderResult.driveId;
      }
      await newSite.save();
    }
    */

    return res.status(201).json(newSite);
  } catch (error) {
    console.error('❌ createSite error:', error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 🔹 Összes site listázása
exports.getAllSites = async (req, res) => {
    try {
        const tenantIdStr = req.scope?.tenantId;
        const tenantObjectId = toObjectId(tenantIdStr);
        if (!tenantObjectId) {
            return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
        }

        const filter = { tenantId: tenantObjectId };
        if (req.query.updatedSince) {
          const raw = String(req.query.updatedSince).trim();
          const asNum = Number(raw);
          const d = Number.isFinite(asNum) ? new Date(asNum) : new Date(raw);
          if (!Number.isNaN(d.getTime())) {
            filter.updatedAt = { $gt: d };
          }
        }

        const sites = await Site.find(filter)
            .populate('CreatedBy', 'firstName lastName nickname');

        res.status(200).json(sites);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Egy site lekérése ID alapján
exports.getSiteById = async (req, res) => {
    try {
        const siteId = req.params.id || req.query.siteId;
        if (!siteId) {
            return res.status(400).json({ message: "Missing site ID" });
        }
        const tenantIdStr = req.scope?.tenantId;
        const tenantObjectId = toObjectId(tenantIdStr);
        if (!tenantObjectId) {
            return res.status(400).json({ message: "Invalid or missing tenantId in auth" });
        }
        const site = await Site.findOne({ _id: siteId, tenantId: tenantObjectId })
          .populate('CreatedBy', 'firstName lastName nickname');
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }

        res.status(200).json(site);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Rövid összesítő (zónák, eszközök, státuszok)
exports.getSiteSummary = async (req, res) => {
  try {
    const siteId = req.params.id;
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    const siteObjectId = toObjectId(siteId);

    if (!tenantObjectId || !siteObjectId) {
      return res.status(400).json({ message: 'Invalid site or tenant ID.' });
    }

    const [zoneCount, zoneStats] = await Promise.all([
      Zone.countDocuments({ Site: siteObjectId, tenantId: tenantObjectId }),
      Equipment.aggregate([
        {
          $match: {
            tenantId: tenantObjectId,
            Site: siteObjectId
          }
        },
        {
          $group: {
            _id: '$Zone',
            total: { $sum: 1 },
            passed: {
              $sum: {
                $cond: [{ $eq: ['$Compliance', 'Passed'] }, 1, 0]
              }
            },
            failed: {
              $sum: {
                $cond: [{ $eq: ['$Compliance', 'Failed'] }, 1, 0]
              }
            },
            na: {
              $sum: {
                $cond: [{ $eq: ['$Compliance', 'NA'] }, 1, 0]
              }
            }
          }
        }
      ])
    ]);

    const zoneStatsFormatted = zoneStats.map(stat => ({
      zoneId: stat._id ? stat._id.toString() : 'unassigned',
      equipmentCount: stat.total,
      statusCounts: {
        Passed: stat.passed,
        Failed: stat.failed,
        NA: stat.na
      }
    }));

    const statusCounts = zoneStatsFormatted.reduce(
      (acc, stat) => {
        acc.Passed += stat.statusCounts.Passed;
        acc.Failed += stat.statusCounts.Failed;
        acc.NA += stat.statusCounts.NA;
        return acc;
      },
      { Passed: 0, Failed: 0, NA: 0 }
    );

    const deviceCount = zoneStatsFormatted.reduce(
      (sum, stat) => sum + stat.equipmentCount,
      0
    );

    return res.json({
      siteId: siteObjectId.toString(),
      zoneCount,
      deviceCount,
      statusCounts,
      zoneStats: zoneStatsFormatted
    });
  } catch (error) {
    console.error('❌ getSiteSummary error:', error);
    return res.status(500).json({
      message: 'Failed to fetch site summary.',
      error: error.message || String(error)
    });
  }
};

// GET /api/sites/:id/operational-summary
exports.getSiteOperationalSummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });
    const siteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(siteId)) {
      return res.status(400).json({ message: 'Invalid site id.' });
    }

    const summary = await computeOperationalSummary({
      tenantId,
      siteId
    });

    return res.json({ siteId, ...summary });
  } catch (error) {
    console.error('❌ getSiteOperationalSummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch site operational summary.' });
  }
};

// GET /api/sites/:id/overall-status-summary
exports.getSiteOverallStatusSummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });
    const siteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(siteId)) {
      return res.status(400).json({ message: 'Invalid site id.' });
    }

    const summary = await computeOverallStatusSummary({ tenantId, siteId });
    return res.json({ siteId, ...summary });
  } catch (error) {
    console.error('❌ getSiteOverallStatusSummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch site overall status summary.' });
  }
};

// GET /api/sites/:id/maintenance-severity-summary
exports.getSiteMaintenanceSeveritySummary = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });
    const siteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(siteId)) {
      return res.status(400).json({ message: 'Invalid site id.' });
    }

    const summary = await computeMaintenanceSeveritySummary({
      tenantId,
      siteId
    });

    return res.json({ siteId, ...summary });
  } catch (error) {
    console.error('❌ getSiteMaintenanceSeveritySummary error:', error);
    return res.status(500).json({ message: 'Failed to fetch site maintenance severity summary.' });
  }
};

// 🔹 Site módosítása
exports.updateSite = async (req, res) => {
  try {
    const { Name, Client, Note, CreatedBy } = req.body;

    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    let site = await Site.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!site) {
      return res.status(404).json({ message: "Site not found" });
    }

    site.Name = Name || site.Name;
    site.Client = Client || site.Client;
    if (Note !== undefined) {
      site.Note = Note;
    }

    if (CreatedBy && CreatedBy !== String(site.CreatedBy)) {
      const u = await User.findById(CreatedBy);
      if (!u) return res.status(404).json({ message: "User not found" });
      site.CreatedBy = CreatedBy;
    }

    // LEGACY rename (OneDrive/SharePoint) — removed:
    /*
    const user = await User.findById(req.userId);
    const hasEntraID = !!user?.tenantId;
    const accessToken = req.headers['x-ms-graph-token'];
    if (hasEntraID && accessToken && site.oneDriveFolderId && newName && newName !== oldName) {
      const { renameOneDriveItemById } = require('../controllers/graphController');
      await renameOneDriveItemById(site.oneDriveFolderId, accessToken, newName);
    }
    if (hasEntraID && accessToken && site.sharePointFolderId && newName && newName !== oldName) {
      const { renameSharePointItemById } = require('../helpers/sharePointHelpers');
      await renameSharePointItemById(accessToken, site.sharePointFolderId, newName, site.sharePointDriveId);
    }
    */

    await site.save();
    res.status(200).json(site);
  } catch (error) {
    console.error("❌ Site módosítás hiba:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 🔹 Site törlése
exports.deleteSite = async (req, res) => {
  try {
    const siteId = req.params.id;
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const site = await Site.findOne({ _id: siteId, tenantId: tenantObjectId });
    if (!site) return res.status(404).json({ message: "Site not found" });

    try {
      await recordTombstone({
        tenantId: tenantObjectId,
        entityType: 'site',
        entityId: site._id,
        deletedBy: req.userId || null,
        meta: { Name: site.Name || '' }
      });
    } catch (e) {
      console.warn('⚠️ Failed to write site tombstone:', e?.message || e);
    }

    // child records
    await Equipment.deleteMany({ Site: siteId, tenantId: tenantObjectId });
    await Zone.deleteMany({ Site: siteId, tenantId: tenantObjectId });

    // Blob prefix törlése
    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, String(site._id));
    try {
      await azureBlob.deletePrefix(`${sitePrefix}/`);
    } catch (e) {
      console.warn('⚠️ deletePrefix warning:', e?.message);
    }

    await site.deleteOne();

    // LEGACY (Graph/SharePoint) — removed:
    /*
    const accessToken = req.headers['x-ms-graph-token'];
    const user = await User.findById(req.userId);
    const hasEntraID = !!user?.tenantId;
    const { deleteSharePointItemById } = require('../helpers/sharePointHelpers');
    if (hasEntraID && accessToken) {
      if (site.oneDriveFolderId) await deleteOneDriveItemById(site.oneDriveFolderId, accessToken);
      if (site.sharePointFolderId) await deleteSharePointItemById(accessToken, site.sharePointFolderId);
    }
    */

    res.status(200).json({ message: "Site, related zones, equipment deleted (DB) and Blob folder cleared." });
  } catch (error) {
    console.error("❌ Site törlés hiba:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.uploadFileToSite = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const site = await Site.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!site) return res.status(404).json({ message: "Site not found" });

    const files = req.files || [];
    const aliasFromForm = req.body.alias;
    if (!files.length) {
      return res.status(400).json({ message: "No files provided" });
    }

    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, String(site._id));
    const uploadedFiles = [];

    for (const file of files) {
      const safeName = cleanFileName(file.originalname);
      const srcBuffer = fs.readFileSync(file.path);
      const inferredMime = file.mimetype || mime.lookup(safeName) || 'application/octet-stream';
      const { buffer, name: convertedName, contentType } =
        await convertHeicBufferIfNeeded(srcBuffer, safeName, inferredMime);

      const finalName = convertedName;
      const blobPath = `${sitePrefix}/${finalName}`;
      const guessedType = contentType || inferredMime;

      await azureBlob.uploadBuffer(blobPath, buffer, guessedType);

      uploadedFiles.push({
        name: finalName,
        alias: aliasFromForm || finalName,
        blobPath: blobPath,                              // container-relative path
        blobUrl: azureBlob.getBlobUrl(blobPath),         // https url (no SAS)
        type: (guessedType && String(guessedType).startsWith('image')) ? 'image' : 'document',
        url: azureBlob.getBlobUrl(blobPath), // convenience for the frontend
      });
      // strip legacy fields in case older clients send them
      ['oneDriveId','oneDriveUrl','sharePointId','sharePointUrl'].forEach(k => { try { delete uploadedFiles[uploadedFiles.length - 1][k]; } catch {} });

      try { fs.unlinkSync(file.path); } catch {}
    }

    site.documents.push(...uploadedFiles);
    await site.save();

    res.status(200).json({ message: "Files uploaded to Azure Blob", files: uploadedFiles });
  } catch (error) {
    console.error("❌ Multiple file upload error:", error.message || error);
    res.status(500).json({ message: "Failed to upload files", error: error.message });
  }
};
/*
// LEGACY upload (OneDrive/SharePoint) — kept for reference:
// ... previous implementation using getOrCreateFolder, uploadSharePointFile, axios PUT ...
*/

exports.getFilesOfSite = async (req, res) => {
  try {
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });
    const site = await Site.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!site) return res.status(404).json({ message: "Site not found" });

    res.status(200).json(site.documents || []);
  } catch (error) {
    console.error("❌ File list fetch error:", error.message || error);
    res.status(500).json({ message: "Failed to fetch files", error: error.message });
  }
};

exports.deleteFileFromSite = async (req, res) => {
  try {
    const { siteId, fileId } = req.params;
    const tenantIdStr = req.scope?.tenantId;
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    const site = await Site.findOne({ _id: siteId, tenantId: tenantObjectId });
    if (!site) return res.status(404).json({ message: "Site not found" });

    const fileToDelete = site.documents.find(
      doc => doc._id.toString() === fileId || doc.blobPath === fileId || doc.oneDriveId === fileId
    );
    if (!fileToDelete) return res.status(404).json({ message: "File not found in site" });

    const targetPath = fileToDelete.blobPath || fileToDelete.oneDriveId;
    if (targetPath) {
      try { await azureBlob.deleteFile(targetPath); }
      catch (e) { console.warn('⚠️ Blob delete failed:', e?.message); }
    }

    site.documents = site.documents.filter(doc => doc._id.toString() !== fileToDelete._id.toString());
    await site.save();

    res.status(200).json({ message: "File deleted from Azure Blob and DB" });
  } catch (error) {
    console.error("❌ File delete error:", error.message || error);
    res.status(500).json({ message: "Failed to delete file", error: error.message });
  }
};
