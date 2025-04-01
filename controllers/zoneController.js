// controllers/zoneController.js
const Zone = require('../models/zone');
const User = require('../models/user');
const Equipment = require('../models/dataplate');
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios');
const { getOrCreateFolder, deleteOneDriveItemById, renameOneDriveItemById } = require('../controllers/graphController');
const { getOrCreateSharePointFolder, renameSharePointItemById, deleteSharePointItemById, uploadSharePointFile } = require('../helpers/sharePointHelpers');

function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
}

exports.createZone = async (req, res) => {
  try {
    const createdBy = req.user.id;
    const Company = req.user.company;
    const modifiedBy = req.user.id;

    if (!Company) {
      return res.status(400).json({ message: "Company is missing in token" });
    }

    const zone = new Zone({
      ...req.body,
      CreatedBy: createdBy,
      ModifiedBy: modifiedBy,
      Company: Company,
    });

    await zone.save();

    const accessToken = req.headers['x-ms-graph-token'];
    if (accessToken) {
      const relatedSite = await require('../models/site').findById(zone.Site);
      if (relatedSite) {
        const folderPath = `ExAI/Projects/${relatedSite.Name}/${zone.Name}`;
        const folderResult = await getOrCreateFolder(accessToken, folderPath);

        if (folderResult?.folderId) {
          zone.oneDriveFolderUrl = folderResult.folderUrl;
          zone.oneDriveFolderId = folderResult.folderId;
        }

        const userCompany = (req.user.company ?? 'NO_COMPANY').toUpperCase();
        const sharePointPath = `${userCompany}/Projects/${relatedSite.Name}/${zone.Name}`;
        const spFolderResult = await getOrCreateSharePointFolder(accessToken, sharePointPath);
        if (spFolderResult?.folderId) {
          zone.sharePointFolderUrl = spFolderResult.folderUrl;
          zone.sharePointFolderId = spFolderResult.folderId;
          zone.sharePointSiteId = spFolderResult.siteId;
          zone.sharePointDriveId = spFolderResult.driveId;
        }

        await zone.save();
        console.log(`✅ Zóna mappák létrehozva: ${folderPath}, ${sharePointPath}`);
      } else {
        console.warn("⚠️ A zónához tartozó Site nem található, mappa nem jött létre.");
      }
    }

    res.status(201).json({ message: 'Zone created successfully', zone });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getZones = async (req, res) => {
  try {
    const { siteId } = req.query;
    const userCompany = req.user.company;
    if (!userCompany) {
      return res.status(400).json({ message: "Company is missing in token" });
    }

    let query = { Company: userCompany };
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
    const zone = await Zone.findById(req.params.id).populate('CreatedBy', 'nickname');
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    res.status(200).json(zone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateZone = async (req, res) => {
  try {
    if (req.body.CreatedBy) delete req.body.CreatedBy;
    const zone = await Zone.findById(req.params.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const oldName = zone.Name;
    const newName = req.body.Name;

    const user = await User.findById(req.userId);
    const hasEntraID = !!user?.tenantId;
    const accessToken = req.headers['x-ms-graph-token'];

    if (hasEntraID && accessToken && zone.oneDriveFolderId && newName && newName !== oldName) {
    const renameResult = await renameOneDriveItemById(zone.oneDriveFolderId, accessToken, newName);
      if (renameResult?.webUrl) zone.oneDriveFolderUrl = renameResult.webUrl;
      if (renameResult?.id) zone.oneDriveFolderId = renameResult.id;
    }

    if (hasEntraID && accessToken && zone.sharePointFolderId && newName && newName !== oldName) {
      const renameResult = await renameSharePointItemById(accessToken, zone.sharePointFolderId, newName, zone.sharePointDriveId);
      if (renameResult?.webUrl) zone.sharePointFolderUrl = renameResult.webUrl;
    }

    Object.assign(zone, req.body);
    zone.ModifiedBy = req.userId;
    await zone.save();
    res.status(200).json({ message: 'Zone updated successfully', zone });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteZone = async (req, res) => {
  try {
    const zoneId = req.params.id;
    await Equipment.deleteMany({ Zone: zoneId });

    const zone = await Zone.findById(zoneId);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const user = await User.findById(req.userId);
    const hasEntraID = !!user?.tenantId;
    const accessToken = req.headers['x-ms-graph-token'];

    if (hasEntraID && accessToken) {
      if (zone.oneDriveFolderId) await deleteOneDriveItemById(zone.oneDriveFolderId, accessToken);
      if (zone.sharePointFolderId) await deleteSharePointItemById(accessToken, zone.sharePointFolderId);
    }

    await Zone.findByIdAndDelete(zoneId);
    res.status(200).json({ message: 'Zone and related equipment deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.uploadFileToZone = async (req, res) => {
    try {
      const zone = await Zone.findById(req.params.id);
      if (!zone) return res.status(404).json({ message: "Zone not found" });
  
      const accessToken = req.headers['x-ms-graph-token'];
      const files = req.files;
      const aliasFromForm = req.body.alias;
      const enableOneDrive = req.body.enableOneDrive !== 'false';
      const enableSharePoint = req.body.enableSharePoint !== 'false';
  
      const oneDrivePath = req.body.oneDrivePath;
      const sharePointPath = req.body.sharePointPath;
  
      if (!oneDrivePath && !sharePointPath) {
        return res.status(400).json({ message: "Missing oneDrivePath and/or sharePointPath" });
      }
  
      const uploadedFiles = [];
  
      for (const file of files) {
        const fileName = cleanFileName(file.originalname);
        const alias = aliasFromForm || fileName;
        const fileBuffer = fs.readFileSync(file.path);
  
        let oneDriveResult = null;
        let sharePointResult = null;
  
        // ☁️ OneDrive feltöltés
        if (enableOneDrive && accessToken && oneDrivePath) {
          const folder = await getOrCreateFolder(accessToken, oneDrivePath);
          if (folder?.folderId) {
            const uploadResp = await axios.put(
              `https://graph.microsoft.com/v1.0/me/drive/items/${folder.folderId}:/${fileName}:/content`,
              fileBuffer,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/octet-stream',
                },
              }
            );
            oneDriveResult = uploadResp.data;
          }
        }
  
        // 🏢 SharePoint feltöltés
        if (enableSharePoint && accessToken && sharePointPath) {
          try {
            sharePointResult = await uploadSharePointFile(accessToken, sharePointPath, file.path, fileName);
          } catch (spErr) {
            console.warn('⚠️ SharePoint upload failed:', spErr.message);
          }
        }
  
        uploadedFiles.push({
          name: fileName,
          alias,
          oneDriveId: oneDriveResult?.id || null,
          oneDriveUrl: oneDriveResult?.webUrl || null,
          sharePointId: sharePointResult?.id || null,
          sharePointUrl: sharePointResult?.webUrl || null,
          type: file.mimetype.startsWith('image') ? 'image' : 'document',
        });
  
        fs.unlinkSync(file.path);
      }
  
      // ➕ Dokumentumok hozzáadása, mentés
      zone.documents.push(...uploadedFiles);
      await zone.save();
  
      // 📤 Frissen mentett fájlok visszaküldése _id-kkal
      const savedDocs = zone.documents.slice(-uploadedFiles.length);
  
      res.status(200).json({ message: "Files uploaded and saved", files: savedDocs });
    } catch (error) {
      console.error("❌ Multiple file upload error:", error.message || error);
      res.status(500).json({ message: "Failed to upload files", error: error.message });
    }
  };
  

exports.getFilesOfZone = async (req, res) => {
  try {
    const zone = await Zone.findById(req.params.id);
    if (!zone) return res.status(404).json({ message: "Zone not found" });
    res.status(200).json(zone.documents || []);
  } catch (error) {
    res.status(500).json({ message: "Fetch failed", error: error.message });
  }
};

exports.deleteFileFromZone = async (req, res) => {
  try {
    const { zoneId, fileId } = req.params;
    const accessToken = req.headers['x-ms-graph-token'];

    const zone = await Zone.findById(zoneId);
    if (!zone) return res.status(404).json({ message: "Zone not found" });

    const fileToDelete = zone.documents.find(doc =>
      doc.oneDriveId === fileId || doc.sharePointId === fileId || doc._id.toString() === fileId
    );
    if (!fileToDelete) return res.status(404).json({ message: "File not found" });

    if (fileToDelete.oneDriveId) {
      try {
        await deleteOneDriveItemById(fileToDelete.oneDriveId, accessToken);
      } catch (err) {
        console.warn(`⚠️ OneDrive delete failed: ${fileToDelete.oneDriveId}`);
      }
    }

    if (fileToDelete.sharePointId) {
      try {
        await deleteSharePointItemById(accessToken, fileToDelete.sharePointId);
      } catch (err) {
        console.warn(`⚠️ SharePoint delete failed: ${fileToDelete.sharePointId}`);
      }
    }

    zone.documents = zone.documents.filter(doc => doc._id.toString() !== fileToDelete._id.toString());
    await zone.save();

    res.status(200).json({ message: "File deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete", error: error.message });
  }
};
