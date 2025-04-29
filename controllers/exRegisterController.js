const Equipment = require('../models/dataplate'); // Itt használjuk a valódi model nevét
const Zone = require('../models/zone')
const Site = require('../models/site');
const logger = require('../config/logger'); // ha van loggered, vagy kiveheted
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios'); // ezt is, ha OneDrive-hoz képek feltöltése van
const { getOrCreateFolder, deleteOneDriveItemById, renameOneDriveItemById, moveOneDriveItemToFolder} = require('../controllers/graphController');
const { getOrCreateSharePointFolder, renameSharePointItemById, deleteSharePointItemById, uploadSharePointFile, moveSharePointItemToFolder } = require('../helpers/sharePointHelpers');


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
  try {
    const CreatedBy = req.userId;
    const Company = req.user.company;

    if (!Company) {
      return res.status(400).json({ message: "Company is missing in token" });
    }

    const azureToken = req.headers['x-ms-graph-token'];
    const files = Array.isArray(req.files) ? req.files : [];

    let equipmentData = [];
    if (typeof req.body.equipmentData === 'string') {
      equipmentData = JSON.parse(req.body.equipmentData);
    } else if (Array.isArray(req.body.equipmentData)) {
      equipmentData = req.body.equipmentData;
    } else if (Array.isArray(req.body)) {
      equipmentData = req.body;
    }

    if (!equipmentData.length) {
      return res.status(400).json({ message: "No equipment data received." });
    }

    const results = [];

    for (const equipment of equipmentData) {
      const _id = equipment._id || null;
      const eqId = equipment.EqID || new mongoose.Types.ObjectId().toString();

      let existingEquipment = null;
      if (_id) {
        existingEquipment = await Equipment.findById(_id);
      }
      if (!existingEquipment && eqId) {
        existingEquipment = await Equipment.findOne({
          EqID: eqId,
          Company,
          Site: equipment.Site || null,
          Zone: equipment.Zone || null
        });
      }

      let zoneDoc = null;
      let siteDoc = null;
      let folderPath, sharePointPath;

      if (equipment.Zone && equipment.Site) {
        zoneDoc = await Zone.findById(equipment.Zone).lean();
        siteDoc = await Site.findById(equipment.Site).lean();
        const zoneName = zoneDoc?.Name || `Zone_${equipment.Zone}`;
        const siteName = siteDoc?.Name || `Site_${equipment.Site}`;
        folderPath = `ExAI/Projects/${siteName}/${zoneName}/${eqId}`;
        sharePointPath = `${Company.toUpperCase()}/Projects/${siteName}/${zoneName}/${eqId}`;
      } else {
        folderPath = `ExAI/Equipment/${eqId}`;
        sharePointPath = `${Company.toUpperCase()}/General Equipment/${eqId}`;
      }

      const equipmentFiles = files.filter(file => {
        const eqIdInName = file.originalname.split('__')[0];
        return eqIdInName === eqId;
      });

      let pictures = [];
      let oneDriveFolderId = null;
      let oneDriveFolderUrl = null;
      let sharePointFolderId = null;
      let sharePointFolderUrl = null;

      if (azureToken && equipmentFiles.length > 0) {
        const { folderId: oneDriveId, folderUrl: oneDriveUrl } = await getOrCreateFolder(azureToken, folderPath) || {};
        const { folderId: shareId, folderUrl: shareUrl } = await getOrCreateSharePointFolder(azureToken, sharePointPath) || {};

        oneDriveFolderId = oneDriveId;
        oneDriveFolderUrl = oneDriveUrl;
        sharePointFolderId = shareId;
        sharePointFolderUrl = shareUrl;

        for (const file of equipmentFiles) {
          try {
            const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
            const fileBuffer = fs.readFileSync(file.path);

            let oneDriveUpload = null;
            let sharePointUpload = null;

            if (oneDriveFolderId) {
              const oneDriveUploadUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${oneDriveFolderId}:/${cleanName}:/content`;
              const uploadRes = await axios.put(oneDriveUploadUrl, fileBuffer, {
                headers: {
                  Authorization: `Bearer ${azureToken}`,
                  "Content-Type": file.mimetype
                }
              });
              oneDriveUpload = uploadRes.data;
            }

            if (sharePointFolderId) {
              sharePointUpload = await uploadSharePointFile(azureToken, sharePointPath, file.path, cleanName);
            }

            pictures.push({
              name: cleanName,
              oneDriveId: oneDriveUpload?.id || null,
              oneDriveUrl: oneDriveUpload?.webUrl || null,
              sharePointId: sharePointUpload?.id || null,
              sharePointUrl: sharePointUpload?.webUrl || null,
              uploadedAt: new Date()
            });

            fs.unlinkSync(file.path);
          } catch (err) {
            console.error(`❌ File feldolgozás hiba (${file?.originalname}):`, err.message);
            continue; // továbblép a többi fájlra
          }
        }
      }

      const updateFields = {
        ...equipment,
        EqID: eqId,
        Company,
        Pictures: [...(existingEquipment?.Pictures || []), ...pictures],
        OneDriveFolderId: oneDriveFolderId || existingEquipment?.OneDriveFolderId || null,
        OneDriveFolderUrl: oneDriveFolderUrl || existingEquipment?.OneDriveFolderUrl || null,
        SharePointId: sharePointFolderId || existingEquipment?.SharePointId || null,
        SharePointUrl: sharePointFolderUrl || existingEquipment?.SharePointUrl || null
      };

      if (existingEquipment) {
        updateFields.ModifiedBy = CreatedBy;
        const saved = await Equipment.findByIdAndUpdate(
          existingEquipment._id,
          { $set: updateFields },
          { new: true }
        );
        results.push(saved);
      } else {
        updateFields.CreatedBy = CreatedBy;
        const newEquipment = new Equipment(updateFields);
        const saved = await newEquipment.save();
        results.push(saved);
      }
    }

    return res.status(201).json(results);
  } catch (error) {
    console.error('❌ Hiba createEquipment-ben:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni vagy frissíteni az eszközt.' });
  }
};

exports.uploadImagesToEquipment = async (req, res) => {
  try {
    const equipmentId = req.params.id;
    const azureToken = req.headers['x-ms-graph-token'];
    const files = Array.isArray(req.files) ? req.files : [];

    const equipment = await Equipment.findById(equipmentId);
    if (!equipment) return res.status(404).json({ message: "Equipment not found" });

    if (!azureToken || !files.length) {
      return res.status(400).json({ message: "Missing files or Graph token" });
    }

    let folderPath, sharePointPath;
    const company = req.user.company.toUpperCase();

    if (equipment.Zone && equipment.Site) {
      const zone = await Zone.findById(equipment.Zone);
      const site = await Site.findById(equipment.Site);
      const zoneName = zone?.Name || `Zone_${equipment.Zone}`;
      const siteName = site?.Name || `Site_${equipment.Site}`;

      folderPath = `ExAI/Projects/${siteName}/${zoneName}/${equipment.EqID}`;
      sharePointPath = `${company}/Projects/${siteName}/${zoneName}/${equipment.EqID}`;
    } else {
      folderPath = `ExAI/Equipment/${equipment.EqID}`;
      sharePointPath = `${company}/General Equipment/${equipment.EqID}`;
    }

    const folderResult = await getOrCreateFolder(azureToken, folderPath);
    const shareResult = await getOrCreateSharePointFolder(azureToken, sharePointPath);

    const uploadedPictures = [];

    for (const file of files) {
      const fileBuffer = fs.readFileSync(file.path);
      const safeName = cleanFileName(file.originalname);

      let oneDriveRes = null;
      let sharePointRes = null;

      if (folderResult?.folderId) {
        oneDriveRes = await axios.put(
          `https://graph.microsoft.com/v1.0/me/drive/items/${folderResult.folderId}:/${safeName}:/content`,
          fileBuffer,
          {
            headers: {
              Authorization: `Bearer ${azureToken}`,
              "Content-Type": file.mimetype
            }
          }
        );
      }

      if (shareResult?.folderId) {
        sharePointRes = await uploadSharePointFile(azureToken, sharePointPath, file.path, safeName);
      }

      fs.unlinkSync(file.path);

      uploadedPictures.push({
        name: safeName,
        oneDriveId: oneDriveRes?.data?.id || null,
        oneDriveUrl: oneDriveRes?.data?.webUrl || null,
        sharePointId: sharePointRes?.id || null,
        sharePointUrl: sharePointRes?.webUrl || null,
        uploadedAt: new Date()
      });
    }

    equipment.Pictures = [...(equipment.Pictures || []), ...uploadedPictures];

    equipment.OneDriveFolderId = folderResult?.folderId;
    equipment.OneDriveFolderUrl = folderResult?.folderUrl;
    equipment.SharePointId = shareResult?.folderId;
    equipment.SharePointUrl = shareResult?.folderUrl;

    await equipment.save();

    return res.status(200).json({ message: "Images uploaded", pictures: uploadedPictures });
  } catch (error) {
    console.error('❌ uploadImagesToEquipment error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    if (!req.user || !req.user.company) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    const filter = { Company: req.user.company };

    if (req.query.Zone) {
      filter.Zone = req.query.Zone;
    } else if (req.query.noZone) {
      filter.$or = [{ Zone: null }, { Zone: { $exists: false } }];
    }

    if (req.query.EqID) {
      filter.EqID = req.query.EqID;
    }

    if (req.query.Manufacturer) {
      filter["Manufacturer"] = req.query.Manufacturer;
    }

    if (req.query.SerialNumber) {
      filter["Serial Number"] = req.query.SerialNumber;
    }

    if (req.query.Qualitycheck) {
      filter["Qualitycheck"] = req.query.Qualitycheck === 'true';
    }

    const equipments = await Equipment.find(filter).lean();

    const withPaths = equipments.map(eq => {
      const oneDrivePath = eq.OneDriveFolderUrl || eq.Pictures?.[0]?.oneDriveUrl || null;
      const sharePointPath = eq.SharePointUrl || eq.Pictures?.[0]?.sharePointUrl || null;

      return {
        ...eq,
        OneDrivePath: oneDrivePath,
        SharePointPath: sharePointPath
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

    // 1️⃣ EqID átnevezés OneDrive és SharePoint
    if (azureToken && updatedEquipment && updatedEquipment.EqID !== oldEqID) {
      if (equipment.OneDriveFolderId) {
        try {
          await renameOneDriveItemById(equipment.OneDriveFolderId, azureToken, updatedEquipment.EqID);
          console.log(`✅ OneDrive mappa átnevezve: ${oldEqID} → ${updatedEquipment.EqID}`);
        } catch (err) {
          console.warn("⚠️ OneDrive átnevezési hiba:", err.message);
        }
      }

      if (equipment.SharePointId && equipment.SharePointUrl && equipment.SharePointUrl.includes('/')) {
        try {
          const driveId = equipment.SharePointUrl.split('/').find(s => s.includes('drive')) || updatedEquipment.sharePointDriveId;
          await renameSharePointItemById(azureToken, equipment.SharePointId, updatedEquipment.EqID, driveId);
          console.log(`✅ SharePoint mappa átnevezve: ${oldEqID} → ${updatedEquipment.EqID}`);
        } catch (err) {
          console.warn("⚠️ SharePoint átnevezési hiba:", err.message);
        }
      }
    }

    // 2️⃣ Áthelyezés, ha Site vagy Zone változott
    const oldSiteId = equipment.Site?.toString();
    const oldZoneId = equipment.Zone?.toString();
    const newSiteId = updatedEquipment.Site?.toString();
    const newZoneId = updatedEquipment.Zone?.toString();
    const siteChanged = oldSiteId !== newSiteId;
    const zoneChanged = oldZoneId !== newZoneId;

    if ((siteChanged || zoneChanged) && azureToken) {
      let newPath, sharePointPath;
      const company = Company.toUpperCase();

      if (newSiteId && newZoneId) {
        const site = await Site.findById(newSiteId).lean();
        const zone = await Zone.findById(newZoneId).lean();
        const siteName = site?.Name || `Site_${newSiteId}`;
        const zoneName = zone?.Name || `Zone_${newZoneId}`;

        newPath = `ExAI/Projects/${siteName}/${zoneName}/${updatedEquipment.EqID}`;
        sharePointPath = `${company}/Projects/${siteName}/${zoneName}/${updatedEquipment.EqID}`;
      } else {
        newPath = `ExAI/Equipment/${updatedEquipment.EqID}`;
        sharePointPath = `${company}/General Equipment/${updatedEquipment.EqID}`;
      }

      // 🔁 OneDrive
      if (equipment.OneDriveFolderId) {
        try {
          const newOneDrive = await getOrCreateFolder(azureToken, newPath);
          await moveOneDriveItemToFolder(equipment.OneDriveFolderId, newOneDrive.folderId, azureToken);
          updatedEquipment.OneDriveFolderId = newOneDrive.folderId;
          updatedEquipment.OneDriveFolderUrl = newOneDrive.folderUrl;
        } catch (err) {
          console.warn("⚠️ OneDrive mozgatási hiba:", err.message);
        }
      }

      // 🔁 SharePoint
      if (equipment.SharePointId) {
        try {
          const newShare = await getOrCreateSharePointFolder(azureToken, sharePointPath);
          await moveSharePointItemToFolder(
            azureToken,
            equipment.SharePointId,
            newShare.folderId,
            newShare.driveId // 💡 Ezt most már visszaadja a helper
          );
          updatedEquipment.SharePointId = newShare.folderId;
          updatedEquipment.SharePointUrl = newShare.folderUrl;
        } catch (err) {
          console.warn("⚠️ SharePoint mozgatási hiba:", err.message);
        }
      }

      await updatedEquipment.save();
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

    if (azureToken) {
      if (equipment.OneDriveFolderId) {
        try {
          await deleteOneDriveItemById(equipment.OneDriveFolderId, azureToken);
        } catch (err) {
          console.warn("⚠️ OneDrive törlési hiba:", err.message);
        }
      }

      if (equipment.SharePointId) {
        try {
          await deleteSharePointItemById(azureToken, equipment.SharePointId);
        } catch (err) {
          console.warn("⚠️ SharePoint törlési hiba:", err.message);
        }
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