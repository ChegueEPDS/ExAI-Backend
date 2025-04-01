/* siteController.js: */
const Site = require('../models/site'); // Importáljuk a Site modellt
const User = require('../models/user'); // Importáljuk a User modellt
const Zone = require('../models/zone'); // Ez kell a file tetejére is
const Equipment = require('../models/dataplate'); // 👈 importáljuk a modell tetején
const { getOrCreateFolder, deleteOneDriveItemById } = require('../controllers/graphController');
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios');

function cleanFileName(filename) {
    return filename
      .normalize("NFKD")                         // Szétbontott ékezetek eltávolítása
      .replace(/[\u0300-\u036f]/g, "")           // Diakritikus jelek eltávolítása
      .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");       // Biztonságos karakterek megtartása
  }

// 🔹 Új site létrehozása
exports.createSite = async (req, res) => {
    try {
        const CreatedBy = req.userId;
        const Company = req.user.company;

        if (!Company) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        // 🔎 Felhasználó lekérése tenantId ellenőrzéshez
        const user = await User.findById(CreatedBy);
        const hasEntraID = !!user?.tenantId;

        // 1️⃣ Site létrehozása és mentése
        const newSite = new Site({
            Name: req.body.Name,
            Client: req.body.Client,
            CreatedBy: CreatedBy,
            Company: Company,
        });

        await newSite.save();

        // 2️⃣ OneDrive mappa létrehozása CSAK Entra ID-s usernél
        const accessToken = req.headers['x-ms-graph-token'];
        if (hasEntraID && accessToken) {
            console.log('🔐 Entra ID-s user. Access token megvan, próbáljuk létrehozni a mappát...');
            
            const oneDrivePath = `ExAI/Projects/${newSite.Name}`;
            const userCompany = (req.user.company ?? 'NO_COMPANY').toUpperCase();
            const sharePointPath = `${userCompany}/Projects/${newSite.Name}`;

            // 👉 OneDrive mappa
            const folderResult = await getOrCreateFolder(accessToken, oneDrivePath);
            if (folderResult?.folderId) {
                newSite.oneDriveFolderUrl = folderResult.folderUrl;
                newSite.oneDriveFolderId = folderResult.folderId;
            }

            // 👉 SharePoint mappa
            const { getOrCreateSharePointFolder } = require('../helpers/sharePointHelpers');
            const spFolderResult = await getOrCreateSharePointFolder(accessToken, sharePointPath);
            if (spFolderResult?.folderId) {
                newSite.sharePointFolderUrl = spFolderResult.folderUrl;
                newSite.sharePointFolderId = spFolderResult.folderId;
                newSite.sharePointSiteId = spFolderResult.siteId;
                newSite.sharePointDriveId = spFolderResult.driveId;
            }

            await newSite.save();
            console.log(`✅ OneDrive és SharePoint mappa mentve: ${oneDrivePath}, ${sharePointPath}`);
        } else {
            console.log(`🔹 OneDrive/SharePoint mappa kihagyva. hasEntraID: ${hasEntraID}, token: ${!!accessToken}`);
        }

        // 4️⃣ Válasz kiküldése
        res.status(201).json(newSite);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Összes site listázása
exports.getAllSites = async (req, res) => {
    try {
        const userCompany = req.user.company;

        if (!userCompany) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        const sites = await Site.find({ Company: userCompany })
            .populate('CreatedBy', 'firstName lastName nickname company');

        res.status(200).json(sites);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Egy site lekérése ID alapján
exports.getSiteById = async (req, res) => {
    try {
        const siteId = req.params.id || req.query.siteId; // ⚠️ Kereshetünk params-ban és query-ben is
        if (!siteId) {
            return res.status(400).json({ message: "Missing site ID" });
        }

        const site = await Site.findById(siteId).populate('CreatedBy', 'firstName lastName nickname company');
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

      // 🔍 Site lekérése
      let site = await Site.findById(req.params.id);
      if (!site) {
          return res.status(404).json({ message: "Site not found" });
      }

      const oldName = site.Name;
      const newName = Name;

      // 🔍 Felhasználó ellenőrzés
      const user = await User.findById(req.userId);
      const hasEntraID = !!user?.tenantId;
      const accessToken = req.headers['x-ms-graph-token'];

      // ✏️ OneDrive mappa átnevezés, ha változott a név
      if (hasEntraID && accessToken && site.oneDriveFolderId && newName && newName !== oldName) {
          console.log(`✏️ OneDrive mappa átnevezése: ${oldName} → ${newName}`);
          const { renameOneDriveItemById } = require('../controllers/graphController');
          const renameResult = await renameOneDriveItemById(site.oneDriveFolderId, accessToken, newName);
          if (renameResult?.webUrl) {
              site.oneDriveFolderUrl = renameResult.webUrl;
          }
      }

      // ✏️ SharePoint mappa átnevezés, ha változott a név
      if (hasEntraID && accessToken && site.sharePointFolderId && newName && newName !== oldName) {
          console.log(`✏️ SharePoint mappa átnevezése: ${oldName} → ${newName}`);
          const { renameSharePointItemById } = require('../helpers/sharePointHelpers');
          const renameResult = await renameSharePointItemById(accessToken, site.sharePointFolderId, newName, site.sharePointDriveId);
          if (renameResult?.webUrl) {
              site.sharePointFolderUrl = renameResult.webUrl;
          }
      }

      // Ha változik a CreatedBy, akkor frissítjük a Company mezőt is
      if (CreatedBy && CreatedBy !== site.CreatedBy.toString()) {
          const user = await User.findById(CreatedBy);
          if (!user) {
              return res.status(404).json({ message: "User not found" });
          }
          site.Company = user.company;
      }

      // ✅ Módosítások alkalmazása
      site.Name = newName || site.Name;
      site.Client = Client || site.Client;
      site.CreatedBy = CreatedBy || site.CreatedBy;

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
    const accessToken = req.headers['x-ms-graph-token'];

    const site = await Site.findById(siteId);
    if (!site) return res.status(404).json({ message: "Site not found" });

    const user = await User.findById(req.userId);
    const hasEntraID = !!user?.tenantId;

    const zones = await Zone.find({ Site: siteId });

    // 🔹 Importálás itt a site törléshez is
    const { deleteSharePointItemById } = require('../helpers/sharePointHelpers');

    if (hasEntraID && accessToken) {
      // 🔹 OneDrive törlés, ha van
      if (site.oneDriveFolderId) {
        await deleteOneDriveItemById(site.oneDriveFolderId, accessToken);
        console.log(`🗑️ Site mappa törölve OneDrive-ról (ID: ${site.oneDriveFolderId})`);
      }

      // 🔹 SharePoint törlés, ha van
      if (site.sharePointFolderId) {
        await deleteSharePointItemById(accessToken, site.sharePointFolderId);
        console.log(`🗑️ Site mappa törölve SharePoint-ról (ID: ${site.sharePointFolderId})`);
      }

      // 🔹 Zóna mappák törlése
      for (const zone of zones) {
        if (zone.oneDriveFolderId) {
          await deleteOneDriveItemById(zone.oneDriveFolderId, accessToken);
          console.log(`🗑️ Zóna mappa törölve OneDrive-ról: ${zone.Name}`);
        }

        if (zone.sharePointFolderId) {
          await deleteSharePointItemById(accessToken, zone.sharePointFolderId);
          console.log(`🗑️ Zóna mappa törölve SharePoint-ról: ${zone.Name}`);
        }
      }
    }

    // 🔹 Adatbázisból törlés
    await Equipment.deleteMany({ Site: siteId });
    await Zone.deleteMany({ Site: siteId });
    await site.deleteOne();

    res.status(200).json({ message: "Site, related zones, equipment, and folders deleted from DB, OneDrive and SharePoint" });
  } catch (error) {
    console.error("❌ Site törlés hiba:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.uploadFileToSite = async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ message: "Site not found" });

    const accessToken = req.headers['x-ms-graph-token'];
    const files = req.files; // Tömb
    const aliasFromForm = req.body.alias;
    const enableOneDrive = req.body.enableOneDrive !== 'false';
    const enableSharePoint = req.body.enableSharePoint !== 'false';

    const oneDrivePath = req.body.oneDrivePath;
    const sharePointPath = req.body.sharePointPath;

    if (!oneDrivePath && !sharePointPath) {
      return res.status(400).json({ message: "Missing oneDrivePath and/or sharePointPath" });
    }

    console.log('📁 OneDrive path (backend):', oneDrivePath);
    console.log('📁 SharePoint path (backend):', sharePointPath);

    const uploadedFiles = [];

    for (const file of files) {
      const fileName = cleanFileName(file.originalname);
      const alias = aliasFromForm || fileName;
      const fileBuffer = fs.readFileSync(file.path);

      let oneDriveResult = null;
      let sharePointResult = null;

      // ☁️ OneDrive feltöltés
      if (enableOneDrive && accessToken && oneDrivePath) {
        const { getOrCreateFolder } = require('../controllers/graphController');
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
        const { uploadSharePointFile } = require('../helpers/sharePointHelpers');
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

      fs.unlinkSync(file.path); // Temp fájl törlése
    }

    site.documents.push(...uploadedFiles);
    await site.save();

    res.status(200).json({ message: "Files uploaded and saved", files: uploadedFiles });
  } catch (error) {
    console.error("❌ Multiple file upload error:", error.message || error);
    res.status(500).json({ message: "Failed to upload files", error: error.message });
  }
};

exports.getFilesOfSite = async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
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
    const accessToken = req.headers['x-ms-graph-token'];

    const site = await Site.findById(siteId);
    if (!site) return res.status(404).json({ message: "Site not found" });

    const fileToDelete = site.documents.find(
      doc => doc.oneDriveId === fileId || doc.sharePointId === fileId || doc._id.toString() === fileId
    );

    if (!fileToDelete) return res.status(404).json({ message: "File not found in site" });

    if (!accessToken) {
      return res.status(400).json({ message: "Missing access token" });
    }

    // 🔹 OneDrive törlés, ha van
    if (fileToDelete.oneDriveId) {
      try {
        await deleteOneDriveItemById(fileToDelete.oneDriveId, accessToken);
        console.log(`🗑️ OneDrive fájl törölve: ${fileToDelete.oneDriveId}`);
      } catch (err) {
        console.warn(`⚠️ OneDrive törlés sikertelen: ${fileToDelete.oneDriveId}`);
      }
    }

    // 🔹 SharePoint törlés, ha van
    if (fileToDelete.sharePointId) {
      try {
        const { deleteSharePointItemById } = require('../helpers/sharePointHelpers');
        await deleteSharePointItemById(accessToken, fileToDelete.sharePointId);
        console.log(`🗑️ SharePoint fájl törölve: ${fileToDelete.sharePointId}`);
      } catch (err) {
        console.warn(`⚠️ SharePoint törlés sikertelen: ${fileToDelete.sharePointId}`);
      }
    }

    // 🔹 DB frissítés
    site.documents = site.documents.filter(doc => doc._id.toString() !== fileToDelete._id.toString());
    await site.save();

    res.status(200).json({ message: "File deleted from site, OneDrive and SharePoint if applicable" });
  } catch (error) {
    console.error("❌ File delete error:", error.message || error);
    res.status(500).json({ message: "Failed to delete file", error: error.message });
  }
};