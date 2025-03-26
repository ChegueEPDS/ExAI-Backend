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
        
            const folderPath = `ExAI/Projects/${newSite.Name}`;
            const folderResult = await getOrCreateFolder(accessToken, folderPath);
        
            console.log('📁 OneDrive folder result:', folderResult);
        
            if (folderResult && folderResult.folderId) {
                newSite.oneDriveFolderUrl = folderResult.folderUrl;
                newSite.oneDriveFolderId = folderResult.folderId;
                await newSite.save();
                console.log(`✅ OneDrive mappa létrejött: ${folderPath}`);
            } else {
                console.warn(`⚠️ Nem sikerült létrehozni a mappát: ${folderPath}`);
            }
        } else {
            console.log(`🔹 OneDrive mappa kihagyva. hasEntraID: ${hasEntraID}, token: ${!!accessToken}`);
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
        const sites = await Site.find().populate('CreatedBy', 'firstName lastName nickname company'); // Betöltjük a user adatait is
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

        // 🔍 Felhasználó ellenőrzés a OneDrive-hoz
        const user = await User.findById(req.userId);
        const hasEntraID = !!user?.tenantId;
        const accessToken = req.headers['x-ms-graph-token'];

        // ✏️ OneDrive mappa átnevezés, ha változott a név
        if (hasEntraID && accessToken && site.oneDriveFolderId && newName && newName !== oldName) {
            console.log(`✏️ Site mappa átnevezése: ${oldName} → ${newName}`);
            const { renameOneDriveItemById } = require('../controllers/graphController');
            const renameResult = await renameOneDriveItemById(site.oneDriveFolderId, newName, accessToken);
            if (renameResult?.webUrl) {
                site.oneDriveFolderUrl = renameResult.webUrl;
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

        const site = await Site.findById(siteId);
        if (!site) return res.status(404).json({ message: "Site not found" });

        const user = await User.findById(req.userId);
        const hasEntraID = !!user?.tenantId;
        const accessToken = req.headers['x-ms-graph-token'];

        const zones = await Zone.find({ Site: siteId });

        if (hasEntraID && accessToken) {
            // 🗑️ Site mappa törlése
            if (site.oneDriveFolderUrl) {
                const folderId = site.oneDriveFolderId;
                if (folderId) {
                    await deleteOneDriveItemById(folderId, accessToken);
                    console.log(`🗑️ Site mappa törölve OneDrive-ról (ID: ${folderId})`);
                }
            }

            // 🗑️ Zóna mappák törlése
            for (const zone of zones) {
                if (zone.oneDriveFolderUrl) {
                    const folderId = zone.oneDriveFolderId;
                    if (folderId) {
                        await deleteOneDriveItemById(folderId, accessToken);
                        console.log(`🗑️ Zóna mappa törölve: ${zone.Name} (ID: ${folderId})`);
                    }
                }
            }
        } else {
            console.log(`🔹 OneDrive törlés kihagyva. hasEntraID: ${hasEntraID}, token: ${!!accessToken}`);
        }

        await Equipment.deleteMany({ Site: siteId });
        await Zone.deleteMany({ Site: siteId });
        await site.deleteOne();

        res.status(200).json({ message: "Site, related zones, equipment, and OneDrive folders deleted successfully" });
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
      const files = req.files; // most már tömb
      const folderId = site.oneDriveFolderId;
  
      if (!folderId || !accessToken) {
        return res.status(400).json({ message: "Missing OneDrive access or folder" });
      }
  
      const uploadedFiles = [];
  
      for (const file of files) {
        const fileBuffer = fs.readFileSync(file.path);
  
        const uploadResponse = await axios.put(
          `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${encodeURIComponent(cleanFileName(file.originalname))}:/content`,
          fileBuffer,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/octet-stream'
            }
          }
        );
  
        uploadedFiles.push({
          name: file.originalname,
          oneDriveId: uploadResponse.data.id,
          oneDriveUrl: uploadResponse.data.webUrl,
          type: file.mimetype.startsWith('image') ? 'image' : 'document'
        });
  
        fs.unlinkSync(file.path); // töröljük a temp fájlt
      }
  
      site.documents.push(...uploadedFiles); // hozzáadjuk az összeset
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
  
      const fileToDelete = site.documents.find(doc => doc.oneDriveId === fileId);
      if (!fileToDelete) return res.status(404).json({ message: "File not found in site" });
  
      if (!accessToken) {
        return res.status(400).json({ message: "Missing OneDrive access token" });
      }
  
      // 1️⃣ Próbáljuk meg törölni a OneDrive-ból
      try {
        await axios.delete(
          `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        console.log(`🗑️ Fájl törölve OneDrive-ból (ID: ${fileId})`);
      } catch (deleteErr) {
        console.warn(`⚠️ OneDrive törlés sikertelen vagy nem szükséges (ID: ${fileId})`, deleteErr.response?.status);
      }
  
      // 2️⃣ Töröljük a dokumentumot a Site modellből
      site.documents = site.documents.filter(doc => doc.oneDriveId !== fileId);
      await site.save();
  
      res.status(200).json({ message: "File deleted from site and OneDrive (if applicable)" });
    } catch (error) {
      console.error("❌ File delete error:", error.message || error);
      res.status(500).json({ message: "Failed to delete file", error: error.message });
    }
  };