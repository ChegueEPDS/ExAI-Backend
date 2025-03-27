const Equipment = require('../models/dataplate'); // Itt használjuk a valódi model nevét
const Zone = require('../models/zone')
const Site = require('../models/site');
const logger = require('../config/logger'); // ha van loggered, vagy kiveheted
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios'); // ezt is, ha OneDrive-hoz képek feltöltése van
const { getOrCreateFolder, deleteOneDriveItemById, renameOneDriveItemById } = require('../controllers/graphController');

// Létrehozás (POST /exreg)
// 🔧 Segédfüggvény a fájlnév tisztítására
function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
}

// 📥 Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  console.log('📥 equipmentData:', req.body.equipmentData);
console.log('📸 Feltöltött fájlok:', req.files.map(f => f.originalname));
  try {
    const CreatedBy = req.userId;
    const Company = req.user.company;

    if (!Company) {
      return res.status(400).json({ message: "Company is missing in token" });
    }

    const azureToken = req.headers['x-ms-graph-token'];
    const equipmentData = JSON.parse(req.body.equipmentData || "[]");
    const files = req.files || [];

    const processedEquipments = [];

    for (const equipment of equipmentData) {
      const eqId = equipment.EqID || new mongoose.Types.ObjectId().toString();

      let folderPath;
      if (equipment.Zone && equipment.Site) {
        const zoneDoc = await Zone.findById(equipment.Zone).lean();
        const siteDoc = await Site.findById(equipment.Site).lean();
        const zoneName = zoneDoc?.Name || `Zone_${equipment.Zone}`;
        const siteName = siteDoc?.Name || `Site_${equipment.Site}`;
        folderPath = `ExAI/Projects/${siteName}/${zoneName}/${eqId}`;
      } else {
        folderPath = `ExAI/Equipment/${eqId}`;
      }

      const equipmentFiles = files.filter((file) => {
        const eqIdInName = file.originalname.split('__')[0];
        return eqIdInName === eqId;
      });

      let pictures = [];
      let oneDriveFolderId = null;
      let oneDriveFolderUrl = null;

      if (azureToken && equipmentFiles.length > 0) {
        const folderResult = await getOrCreateFolder(azureToken, folderPath);

        if (folderResult?.folderId) {
          oneDriveFolderId = folderResult.folderId;
          oneDriveFolderUrl = folderResult.folderUrl;

          for (const file of equipmentFiles) {
            try {
              const fileBuffer = fs.readFileSync(file.path);
              const cleanName = file.originalname.split('__')[1] || file.originalname;
              const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${folderResult.folderId}:/${cleanFileName(cleanName)}:/content`;

              const uploadResponse = await axios.put(uploadUrl, fileBuffer, {
                headers: {
                  Authorization: `Bearer ${azureToken}`,
                  "Content-Type": file.mimetype
                }
              });

              fs.unlinkSync(file.path);

              pictures.push({
                name: cleanFileName(cleanName),
                oneDriveId: uploadResponse.data.id,
                oneDriveUrl: uploadResponse.data.webUrl,
                uploadedAt: new Date()
              });
            } catch (err) {
              console.error("❌ Feltöltési hiba:", err);
            }
          }
        }
      }

      const finalEquipment = {
        ...equipment,
        EqID: eqId,
        CreatedBy,
        Company,
        Pictures: pictures,
        OneDriveFolderId: oneDriveFolderId,
        OneDriveFolderUrl: oneDriveFolderUrl
      };

      processedEquipments.push(finalEquipment);
    }

    const savedEquipments = await Equipment.insertMany(processedEquipments);
    return res.status(201).json(savedEquipments);
  } catch (error) {
    console.error('❌ Hiba createEquipment-ben:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni az eszközt.' });
  }
};

// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    if (!req.user || !req.user.company) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    const filter = { Company: req.user.company }; // 🔹 Csak az adott vállalat eszközei

    // 🔹 Zone alapú szűrés
    if (req.query.Zone) {
      filter.Zone = req.query.Zone; // Ha egy adott zónához tartozó adatokat kérünk
    } else if (req.query.noZone) {
      filter.$or = [{ Zone: null }, { Zone: { $exists: false } }]; // 🔹 Ha nincs zóna, akkor csak a NULL vagy nem létező Zone mezőket kérjük le
    }

    console.log("Lekérdezés szűrője:", filter); // Debug log
    const equipments = await Equipment.find(filter).lean();
    console.log("Lekérdezett adatok:", equipments); // Debug log

    // Kiegészítés OneDrivePath mezővel
    const withPaths = equipments.map(eq => {
      const oneDrivePath = eq.OneDriveFolderUrl || (eq?.Pictures?.[0]?.oneDriveUrl ?? null);

      return {
        ...eq,
        OneDrivePath: oneDrivePath
      };
    });

    return res.json(withPaths);
  } catch (error) {
    console.error('Hiba történt az eszközök listázásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült lekérni az eszközöket.' });
  }
};

// Módosítás (PUT /exreg/:id)
exports.updateEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const ModifiedBy = req.userId;
    const Company = req.user.company;
    const azureToken = req.headers['x-ms-graph-token'];

    if (!ModifiedBy || !Company) {
      return res.status(401).json({ error: 'Hiányzó jogosultság.' });
    }

    const equipment = await Equipment.findOne({ _id: id, Company });
    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    const oldEqID = req.body.OriginalEqID || equipment.EqID;
    const updatedFields = { ...req.body };
    delete updatedFields.CreatedBy;
    updatedFields.ModifiedBy = new mongoose.Types.ObjectId(ModifiedBy);

    const updatedEquipment = await Equipment.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    );

    // 🟡 OneDrive átnevezés csak akkor, ha változott az EqID és van folderId
    if (azureToken && updatedEquipment && updatedEquipment.EqID !== oldEqID && equipment.OneDriveFolderId) {
      try {
        await renameOneDriveItemById(equipment.OneDriveFolderId, azureToken, updatedEquipment.EqID);
        console.log(`✅ OneDrive mappa átnevezve: ${oldEqID} → ${updatedEquipment.EqID}`);
      } catch (err) {
        console.warn("⚠️ OneDrive átnevezési hiba:", err.message);
      }
    }

    return res.json(updatedEquipment);
  } catch (error) {
    console.error('❌ Hiba módosítás közben:', error);
    return res.status(500).json({ error: 'Nem sikerült módosítani az eszközt.' });
  }
};

// Törlés (DELETE /exreg/:id)
exports.deleteEquipment = async (req, res) => {
  const { id } = req.params;
  try {
    const user = req.user;
    const azureToken = req.headers['x-ms-graph-token'];

    if (!user || !user.company) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    const equipment = await Equipment.findOne({ _id: id, Company: user.company });
    if (!equipment) {
      return res.status(404).json({ error: 'Az eszköz nem található vagy nem tartozik a vállalatához.' });
    }

    // 🗑️ OneDrive törlés folderId alapján
    if (azureToken && equipment.OneDriveFolderId) {
      try {
        await deleteOneDriveItemById(equipment.OneDriveFolderId, azureToken);
        console.log(`✅ OneDrive mappa törölve (ID alapján): ${equipment.OneDriveFolderId}`);
      } catch (err) {
        console.warn("⚠️ OneDrive törlési hiba:", err.message);
      }
    }

    await Equipment.deleteOne({ _id: id });
    return res.json({ message: 'Az eszköz sikeresen törölve.' });
  } catch (error) {
    console.error('❌ Hiba az eszköz törlésekor:', error);
    return res.status(500).json({ error: 'Nem sikerült törölni az eszközt.' });
  }
};

// Gyártók lekérdezése (GET /api/manufacturers)
exports.getManufacturers = async (req, res) => {
  try {
      const manufacturers = await Equipment.distinct("Manufacturer"); // Egyedi gyártók lekérése
      res.json(manufacturers);
  } catch (error) {
      console.error("Error fetching manufacturers:", error);
      res.status(500).json({ error: "Server error while fetching manufacturers." });
  }
};