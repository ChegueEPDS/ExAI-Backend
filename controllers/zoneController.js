const Zone = require('../models/zone'); // A Zone modell importálása
const User = require('../models/user'); 
const Equipment = require('../models/dataplate'); // 👈 hozzáadandó a fájl tetejére
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios');
const { getOrCreateFolder, deleteOneDriveItemById, renameOneDriveItemById } = require('../controllers/graphController');

function cleanFileName(filename) {
    return filename
      .normalize("NFKD")                         // Szétbontott ékezetek eltávolítása
      .replace(/[\u0300-\u036f]/g, "")           // Diakritikus jelek eltávolítása
      .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");       // Biztonságos karakterek megtartása
  }

// Új zóna létrehozása
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

                if (folderResult && folderResult.folderId) {
                    zone.oneDriveFolderUrl = folderResult.folderUrl;
                    zone.oneDriveFolderId = folderResult.folderId;

                    await zone.save(); // 💾 újra mentjük a frissített mezőkkel

                    console.log(`✅ Zóna mappa létrejött: ${folderPath}`);
                } else {
                    console.warn(`⚠️ Nem sikerült létrehozni a zóna mappát: ${folderPath}`);
                }
            } else {
                console.warn("⚠️ A zónához tartozó Site nem található, mappa nem jött létre.");
            }
        }

        res.status(201).json({ message: 'Zone created successfully', zone });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Összes zóna lekérdezése siteId szerint szűrve
exports.getZones = async (req, res) => {
    try {
        const { siteId } = req.query; // 📌 Az URL query paraméteréből kapjuk a siteId-t
        const userCompany = req.user.company; // 📌 Tokenből kapott felhasználói cég

        if (!userCompany) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        let query = { Company: userCompany }; // 🔹 Csak a bejelentkezett cég zónái

        if (siteId) {
            if (!mongoose.Types.ObjectId.isValid(siteId)) {
                console.error('Invalid siteId:', siteId); // 🔍 Konzol log a szerver oldalon
                return res.status(400).json({ message: "Invalid siteId format" });
            }
            query.Site = new mongoose.Types.ObjectId(siteId); // 🔹 Biztosítjuk, hogy ObjectId formátumú legyen
        }

        console.log('Query being executed:', query); // 🔍 Debug log

        const zones = await Zone.find(query).populate('CreatedBy', 'nickname');
        res.status(200).json(zones);
    } catch (error) {
        console.error('Error fetching zones:', error);
        res.status(500).json({ error: error.message });
    }
};

// Egy konkrét zóna lekérdezése ID alapján
exports.getZoneById = async (req, res) => {
    try {
        const zone = await Zone.findById(req.params.id).populate('CreatedBy', 'nickname');
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        res.status(200).json(zone);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Zóna módosítása ID alapján
exports.updateZone = async (req, res) => {
    try {
        if (req.body.CreatedBy) {
            delete req.body.CreatedBy;
        }

        const zone = await Zone.findById(req.params.id);
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }

        const oldName = zone.Name;
        const newName = req.body.Name;

        // 🔁 Ha a zóna neve változott és van OneDrive mappa, próbáljuk átnevezni
        const user = await User.findById(req.userId);
        const hasEntraID = !!user?.tenantId;
        const accessToken = req.headers['x-ms-graph-token'];

        if (hasEntraID && accessToken && zone.oneDriveFolderId && newName && newName !== oldName) {
            console.log(`✏️ Próbáljuk átnevezni a OneDrive mappát: ${oldName} → ${newName}`);
            try {
                const renameResult = await renameOneDriveItemById(zone.oneDriveFolderId, newName, accessToken);
                if (renameResult?.webUrl) {
                    zone.oneDriveFolderUrl = renameResult.webUrl;
                }
                if (renameResult?.id) {
                    zone.oneDriveFolderId = renameResult.id; // ✅ fontos!
                }
            } catch (err) {
                console.warn(`⚠️ OneDrive mappa átnevezés sikertelen:`, err.response?.data || err.message);
            }
        }

        // ✅ Frissítés alkalmazása
        Object.assign(zone, req.body);
        zone.ModifiedBy = req.userId;
        await zone.save();

        res.status(200).json({ message: 'Zone updated successfully', zone });
    } catch (error) {
        console.error("❌ Zóna módosítási hiba:", error);
        res.status(400).json({ error: error.message });
    }
};

// Zóna törlése ID alapján
exports.deleteZone = async (req, res) => {
    try {
        const zoneId = req.params.id;

        // 1️⃣ Töröljük az eszközöket, amik ehhez a zónához tartoznak
        await Equipment.deleteMany({ Zone: zoneId });

        // 2️⃣ Zóna adatainak lekérése
        const zone = await Zone.findById(zoneId);
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }

        const user = await User.findById(req.userId);
        const hasEntraID = !!user?.tenantId;
        const accessToken = req.headers['x-ms-graph-token'];

        if (hasEntraID && accessToken) {
            // 🗑️ Zóna mappa törlése OneDrive-ról
            if (zone.oneDriveFolderId) {
                await deleteOneDriveItemById(zone.oneDriveFolderId, accessToken);
                console.log(`🗑️ Zóna mappa törölve OneDrive-ról (ID: ${zone.oneDriveFolderId})`);
            }
        } else {
            console.log(`🔹 OneDrive törlés kihagyva. hasEntraID: ${hasEntraID}, token: ${!!accessToken}`);
        }

        // 3️⃣ Zóna törlése
        await Zone.findByIdAndDelete(zoneId);

        res.status(200).json({ message: 'Zone and related equipment deleted successfully' });
    } catch (error) {
        console.error("❌ Zóna törlés hiba:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.uploadFileToZone = async (req, res) => {
    try {
      const zone = await Zone.findById(req.params.id);
      if (!zone) return res.status(404).json({ message: "Zone not found" });
  
      const accessToken = req.headers['x-ms-graph-token'];
      const files = req.files;
      const folderId = zone.oneDriveFolderId;
  
      if (!folderId || !accessToken) {
        return res.status(400).json({ message: "Missing OneDrive access or folder" });
      }
  
      const uploadedFiles = [];
  
      for (const file of files) {
        const fileBuffer = fs.readFileSync(file.path);
        const safeFileName = encodeURIComponent(cleanFileName(file.originalname));
          
        const uploadResponse = await axios.put(
          `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${safeFileName}:/content`,
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
  
        fs.unlinkSync(file.path); // 🧹 ideiglenes fájl törlése
      }
  
      zone.documents = zone.documents || [];
      zone.documents.push(...uploadedFiles);
      await zone.save();
  
      res.status(200).json({ message: "Files uploaded and saved", files: uploadedFiles });
    } catch (error) {
      console.error("❌ Zone file upload error:", error);
      res.status(500).json({ message: "Failed to upload files to zone", error: error.message });
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
        doc.oneDriveId === fileId || (doc._id && doc._id.toString() === fileId)
      );
      if (!fileToDelete) return res.status(404).json({ message: "File not found" });
  
      await axios.delete(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
  
      zone.documents = zone.documents.filter(doc => doc.oneDriveId !== fileId);
      await zone.save();
  
      res.status(200).json({ message: "File deleted" });
    } catch (error) {
      console.error("❌ File delete error:", error.message);
      res.status(500).json({ message: "Failed to delete", error: error.message });
    }
  };

