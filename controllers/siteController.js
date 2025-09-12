/* siteController.js: */
const Site = require('../models/site'); // Importáljuk a Site modellt
const User = require('../models/user'); // Importáljuk a User modellt
const Zone = require('../models/zone'); // Ez kell a file tetejére is
const Equipment = require('../models/dataplate'); // 👈 importáljuk a modell tetején
// LEGACY (OneDrive/SharePoint) — kept for reference:
// const { getOrCreateFolder, deleteOneDriveItemById } = require('../controllers/graphController');
const azureBlob = require('../services/azureBlobService');
const path = require('path');
const mongoose = require('mongoose');
const fs = require('fs');
const mime = require('mime-types');

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
function buildSitePrefix(tenantName, tenantId, siteName) {
  return `${buildTenantRoot(tenantName, tenantId)}/projects/${slug(siteName)}`;
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
      CreatedBy: CreatedBy,
      tenantId: tenantObjectId,
    });
    await newSite.save();

    // 2) Azure Blob „mappa” létrehozása (.keep üres blob)
    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, newSite.Name);
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

        const sites = await Site.find({ tenantId: tenantObjectId })
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

// 🔹 Site módosítása
exports.updateSite = async (req, res) => {
  try {
    const { Name, Client, CreatedBy } = req.body;

    const tenantIdStr = req.scope?.tenantId;
    const tenantName = req.scope?.tenantName || '';
    const tenantObjectId = toObjectId(tenantIdStr);
    if (!tenantObjectId) return res.status(400).json({ message: 'Invalid or missing tenantId in auth' });

    let site = await Site.findOne({ _id: req.params.id, tenantId: tenantObjectId });
    if (!site) {
      return res.status(404).json({ message: "Site not found" });
    }

    const oldName = site.Name;
    const newName = Name;

    // Blob „átköltöztetés” ha a név változott
    if (newName && newName !== oldName) {
      const oldPrefix = buildSitePrefix(tenantName, tenantIdStr, oldName);
      const newPrefix = buildSitePrefix(tenantName, tenantIdStr, newName);
      try {
        await azureBlob.renameFile(`${oldPrefix}/.keep`, `${newPrefix}/.keep`);
      } catch (_) {}
      if (Array.isArray(site.documents) && site.documents.length) {
        for (const doc of site.documents) {
          // prefer new blobPath, fall back to legacy oneDriveId if present
          const legacyPath = doc.oneDriveId || '';
          const currentPath = doc.blobPath || legacyPath || '';
          if (!currentPath || !currentPath.startsWith(oldPrefix + '/')) continue;
          const fileName = path.posix.basename(currentPath);
          const newBlobPath = `${newPrefix}/${fileName}`;
          try {
            await azureBlob.renameFile(currentPath, newBlobPath);
            // set new fields
            doc.blobPath = newBlobPath;
            doc.blobUrl = azureBlob.getBlobUrl(newBlobPath);
            // cleanup legacy if present
            if (doc.oneDriveId) delete doc.oneDriveId;
            if (doc.oneDriveUrl) delete doc.oneDriveUrl;
            if (doc.sharePointId) delete doc.sharePointId;
            if (doc.sharePointUrl) delete doc.sharePointUrl;
          } catch (e) {
            console.warn('⚠️ Blob move failed:', currentPath, '→', newBlobPath, e?.message);
          }
        }
      }
      // update site's stored blob prefix
      site.blobPrefix = newPrefix;
    }

    site.Name = newName || site.Name;
    site.Client = Client || site.Client;

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

    // child records
    await Equipment.deleteMany({ Site: siteId, tenantId: tenantObjectId });
    await Zone.deleteMany({ Site: siteId, tenantId: tenantObjectId });

    // Blob prefix törlése
    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, site.Name);
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

    const sitePrefix = buildSitePrefix(tenantName, tenantIdStr, site.Name);
    const uploadedFiles = [];

    for (const file of files) {
      const safeName = cleanFileName(file.originalname);
      const blobPath = `${sitePrefix}/${safeName}`;
      const guessedType = file.mimetype || mime.lookup(safeName) || 'application/octet-stream';
      await azureBlob.uploadFile(file.path, blobPath, guessedType);

      uploadedFiles.push({
        name: safeName,
        alias: aliasFromForm || safeName,
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