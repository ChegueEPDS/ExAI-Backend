// controllers/exRegisterController.js
const Equipment = require('../models/dataplate');
const Zone = require('../models/zone')
const Site = require('../models/site');
const mongoose = require('mongoose');
const fs = require('fs');
const azureBlob = require('../services/azureBlobService');
const mime = require('mime-types');

const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');


// Létrehozás (POST /exreg)
// 🔧 Segédfüggvény a fájlnév tisztítására
function cleanFileName(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
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
function buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, eqId) {
  const root = buildTenantRoot(tenantName, tenantId);
  if (siteName && zoneName) {
    return `${root}/projects/${slug(siteName)}/${slug(zoneName)}/${slug(eqId)}`;
  }
  return `${root}/equipment/${slug(eqId)}`;
}

// Move (copy+delete) all blobs under a prefix to a new prefix
async function moveAllUnderPrefix(oldPrefix, newPrefix) {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is missing');
  const containerName = process.env.AZURE_BLOB_CONTAINER_NAME || 'certificates';

  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(containerName);

  const srcPrefix = String(oldPrefix).replace(/^\/+/, '');
  const dstPrefix = String(newPrefix).replace(/^\/+/, '');

  for await (const item of container.listBlobsFlat({ prefix: srcPrefix })) {
    const fileName = item.name.slice(srcPrefix.length).replace(/^\/+/, '');
    const srcPath = item.name;
    const dstPath = `${dstPrefix}/${fileName}`;
    try {
      await azureBlob.renameFile(srcPath, dstPath);
    } catch (e) {
      try { console.warn('[exreg] moveAllUnderPrefix failed', { srcPath, dstPath, err: e?.message }); } catch {}
    }
  }
}

// 📥 Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  try {
    const CreatedBy = req.userId;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ message: "tenantId is missing from auth" });
    }
    const tenantName = req.scope?.tenantName || '';
    const files = Array.isArray(req.files) ? req.files : [];

    console.log('📥 Új equipment létrehozási kérés érkezett.');
    console.log('🧾 Felhasználó:', CreatedBy);
    console.log('🏢 Tenant:', tenantId);
    console.log('📦 Fájlok száma:', files.length);
    console.log('📨 Kérelmi body (equipmentData):', req.body.equipmentData);
    console.log('📦 Beérkezett fájlok (req.files):');
      files.forEach((f, i) => {
        console.log(`  ${i + 1}. ${f.originalname} (${f.mimetype}, ${f.size} bytes)`);
      });

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
      if (!equipment["X condition"]) {
        equipment["X condition"] = { X: false, Specific: '' };
      }
      if (equipment["X condition"].Specific && equipment["X condition"].Specific.trim() !== '') {
        equipment["X condition"].X = true;
      }

      const _id = equipment._id || null;
      const eqId = equipment.EqID || new mongoose.Types.ObjectId().toString();

      let existingEquipment = null;
      if (_id) {
        existingEquipment = await Equipment.findById(_id);
      }
      if (!existingEquipment && eqId) {
        existingEquipment = await Equipment.findOne({
          EqID: eqId,
          tenantId,
          Site: equipment.Site || null,
          Zone: equipment.Zone || null
        });
      }

      let zoneDoc = null;
      let siteDoc = null;
      if (equipment.Zone && equipment.Site) {
        zoneDoc = await Zone.findById(equipment.Zone).lean();
        siteDoc = await Site.findById(equipment.Site).lean();
      }
      const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
      const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, eqId);

      const equipmentFiles = files.filter(file => {
        const eqIdInName = file.originalname.split('__')[0];
        return eqIdInName === eqId;
      });

      console.log('🔍 EqID a feldolgozáshoz:', eqId);
      console.log('🔍 Fájlok, amelyek eqId alapján illeszkedtek:');
      equipmentFiles.forEach((f, i) => {
        console.log(`  ✅ ${i + 1}. ${f.originalname}`);
      });

      const pictures = [];
      for (const file of equipmentFiles) {
        const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
        const blobPath = `${eqPrefix}/${cleanName}`;
        const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
        await azureBlob.uploadFile(file.path, blobPath, guessedType);
        pictures.push({
          name: cleanName,
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: file.size,
          uploadedAt: new Date()
        });
        try { fs.unlinkSync(file.path); } catch {}
      }

      console.log('💾 Equipment mentésre készül:', {
        EqID: eqId,
        Site: equipment.Site,
        Zone: equipment.Zone,
        PictureCount: pictures.length,
        Pictures: pictures.map(p => p.name)
      });

      const updateFields = {
        ...equipment,
        EqID: eqId,
        tenantId,
        Pictures: [...(existingEquipment?.Pictures || []), ...pictures]
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
    const files = Array.isArray(req.files) ? req.files : [];

    const equipment = await Equipment.findById(equipmentId);
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId' });
    if (equipment?.tenantId && String(equipment.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: 'Forbidden (wrong tenant)' });
    }
    if (!equipment) return res.status(404).json({ message: "Equipment not found" });

    const tenantName = req.scope?.tenantName || '';
    let zoneDoc = null;
    let siteDoc = null;
    if (equipment.Zone && equipment.Site) {
      zoneDoc = await Zone.findById(equipment.Zone);
      siteDoc = await Site.findById(equipment.Site);
    }
    const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
    const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, equipment.EqID);

    console.log('📥 Képfeltöltési kérés érkezett:', {
      equipmentId: req.params.id,
      user: req.user?.email || req.userId,
      filesCount: Array.isArray(req.files) ? req.files.length : 0
    });

    const pictures = [];
    for (const file of files) {
      const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
      await azureBlob.uploadFile(file.path, blobPath, guessedType);
      pictures.push({
        name: cleanName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: file.size,
        uploadedAt: new Date()
      });
      try { fs.unlinkSync(file.path); } catch {}
    }

    equipment.Pictures = [...(equipment.Pictures || []), ...pictures];
    await equipment.save();
    return res.status(200).json({ message: "Images uploaded", pictures });
  } catch (error) {
    console.error('❌ uploadImagesToEquipment error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// 📎 Dokumentumok / képek feltöltése equipment szintre (POST /exreg/:id/upload-documents)
exports.uploadDocumentsToEquipment = async (req, res) => {
  try {
    const equipmentId = req.params.id;
    const files = Array.isArray(req.files) ? req.files : [];
    const aliasFromForm = req.body.alias;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    const tenantName = req.scope?.tenantName || '';

    let zoneDoc = null;
    let siteDoc = null;
    if (equipment.Zone && equipment.Site) {
      zoneDoc = await Zone.findById(equipment.Zone);
      siteDoc = await Site.findById(equipment.Site);
    }
    const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
    const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
    const eqPrefix = buildEquipmentPrefix(
      tenantName,
      tenantId,
      siteName,
      zoneName,
      equipment.EqID || equipment._id.toString()
    );

    if (!files.length) {
      return res.status(400).json({ message: 'No files provided' });
    }

    console.log('📥 Dokumentum feltöltés equipmenthez:', {
      equipmentId,
      tenantId,
      filesCount: files.length
    });

    const docs = [];

    for (const file of files) {
      const cleanName = cleanFileName(file.originalname);
      const blobPath = `${eqPrefix}/${cleanName}`;
      const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';

      await azureBlob.uploadFile(file.path, blobPath, guessedType);

      docs.push({
        name: cleanName,
        alias: aliasFromForm || cleanName,
        type: String(guessedType).startsWith('image') ? 'image' : 'document',
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath),
        contentType: guessedType,
        size: file.size,
        uploadedAt: new Date()
      });

      try { fs.unlinkSync(file.path); } catch {}
    }

    equipment.documents = [...(equipment.documents || []), ...docs];
    await equipment.save();

    const savedDocs = equipment.documents.slice(-docs.length);

    return res.status(200).json({
      message: 'Documents uploaded',
      documents: savedDocs
    });
  } catch (error) {
    console.error('❌ uploadDocumentsToEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to upload documents for equipment.' });
  }
};

// 📄 Equipment dokumentumok listázása (GET /exreg/:id/documents)
exports.getDocumentsOfEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId }).lean();
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    return res.status(200).json(equipment.documents || []);
  } catch (error) {
    console.error('❌ getDocumentsOfEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch documents for equipment.' });
  }
};

// 🗑️ Equipment dokumentum törlése (DELETE /exreg/:id/documents/:docId)
exports.deleteDocumentFromEquipment = async (req, res) => {
  try {
    const { id, docId } = req.params;
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ message: 'Equipment not found' });
    }

    const docs = equipment.documents || [];
    const docToDelete = docs.find(doc =>
      doc._id?.toString() === docId || doc.blobPath === docId
    );

    if (!docToDelete) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const targetPath = docToDelete.blobPath;
    if (targetPath) {
      try {
        await azureBlob.deleteFile(targetPath);
      } catch (e) {
        console.warn('⚠️ Equipment document blob delete failed:', e?.message || e);
      }
    }

    equipment.documents = docs.filter(doc => doc._id.toString() !== docToDelete._id.toString());
    await equipment.save();

    return res.status(200).json({ message: 'Document deleted' });
  } catch (error) {
    console.error('❌ deleteDocumentFromEquipment error:', error);
    return res.status(500).json({ error: error.message || 'Failed to delete document from equipment.' });
  }
};

// GET /exreg/:id
exports.getEquipmentById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Hiányzó tenant azonosító az auth-ból.' });
    }
    const equipment = await Equipment.findOne({ _id: id, tenantId }).lean();

    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    res.json(equipment);
  } catch (error) {
    console.error('❌ Hiba az eszköz lekérdezésekor:', error);
    res.status(500).json({ error: 'Nem sikerült lekérni az eszközt.' });
  }
};

// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó tenant.' });
    }

    const filter = { tenantId };

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
      const firstBlobUrl = eq.Pictures?.find?.(p => p.blobUrl)?.blobUrl || null;
      return { ...eq, BlobPreviewUrl: firstBlobUrl };
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
    const tenantId = req.scope?.tenantId;
    if (!ModifiedBy || !tenantId) {
      return res.status(401).json({ error: 'Hiányzó jogosultság (tenant).' });
    }

    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    // 🔧 Ez a kulcspont: FormData-ból bontsuk ki a JSON-t
    let updatedFields = {};
    if (typeof req.body.equipmentData === 'string') {
      updatedFields = JSON.parse(req.body.equipmentData)[0];
    } else {
      updatedFields = { ...req.body };
    }

    const oldEqID = req.body.OriginalEqID || equipment.EqID;

    // X condition auto-set
    if (!updatedFields["X condition"]) {
      updatedFields["X condition"] = { X: false, Specific: '' };
    }
    if (updatedFields["X condition"].Specific && updatedFields["X condition"].Specific.trim() !== '') {
      updatedFields["X condition"].X = true;
    }

    delete updatedFields.CreatedBy;
    updatedFields.ModifiedBy = new mongoose.Types.ObjectId(ModifiedBy);

    const updatedEquipment = await Equipment.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    );

    // --- Handle blob move if Site/Zone/EqID changed ---
    try {
      const tenantName = req.scope?.tenantName || '';
      const oldSiteId = equipment.Site?.toString();
      const oldZoneId = equipment.Zone?.toString();
      const newSiteId = updatedEquipment.Site?.toString();
      const newZoneId = updatedEquipment.Zone?.toString();
      const siteChanged = oldSiteId !== newSiteId;
      const zoneChanged = oldZoneId !== newZoneId;
      const eqIdChanged = (updatedEquipment.EqID && updatedEquipment.EqID !== oldEqID);

      if (siteChanged || zoneChanged || eqIdChanged) {
        // fetch names for prefixes
        let oldSiteName = null, oldZoneName = null, newSiteName = null, newZoneName = null;
        if (oldSiteId) { const s = await Site.findById(oldSiteId).select('Name'); oldSiteName = s?.Name || null; }
        if (oldZoneId) { const z = await Zone.findById(oldZoneId).select('Name'); oldZoneName = z?.Name || null; }
        if (newSiteId) { const s2 = await Site.findById(newSiteId).select('Name'); newSiteName = s2?.Name || null; }
        if (newZoneId) { const z2 = await Zone.findById(newZoneId).select('Name'); newZoneName = z2?.Name || null; }

        const oldPrefix = buildEquipmentPrefix(tenantName, req.scope?.tenantId, oldSiteName, oldZoneName, oldEqID);
        const newPrefix = buildEquipmentPrefix(tenantName, req.scope?.tenantId, newSiteName, newZoneName, updatedEquipment.EqID);

        // ensure destination prefix exists
        try {
          await azureBlob.uploadBuffer(`${newPrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
            metadata: { kind: 'eq-keep', moved: '1' }
          });
        } catch {}

        await moveAllUnderPrefix(oldPrefix, newPrefix);

        // rewrite picture paths and urls in DB
        if (Array.isArray(updatedEquipment.Pictures) && updatedEquipment.Pictures.length) {
          let changed = false;
          updatedEquipment.Pictures.forEach(pic => {
            if (pic.blobPath && pic.blobPath.startsWith(oldPrefix + '/')) {
              const fileName = pic.blobPath.slice(oldPrefix.length + 1);
              const np = `${newPrefix}/${fileName}`;
              pic.blobPath = np;
              pic.blobUrl = azureBlob.getBlobUrl(np);
              changed = true;
            }
          });
          if (changed) {
            await updatedEquipment.save();
          }
        }
      }
    } catch (moveErr) {
      try { console.warn('⚠️ Blob move on equipment update failed:', moveErr?.message || moveErr); } catch {}
    }

    // Új képek feltöltése, ha vannak fájlok (Azure Blob)
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length > 0) {
      const tenantName = req.scope?.tenantName || '';
      let zoneDoc = null;
      let siteDoc = null;
      if (updatedEquipment.Zone && updatedEquipment.Site) {
        siteDoc = await Site.findById(updatedEquipment.Site).lean();
        zoneDoc = await Zone.findById(updatedEquipment.Zone).lean();
      }
      const zoneName = zoneDoc?.Name || (updatedEquipment.Zone ? `Zone_${updatedEquipment.Zone}` : null);
      const siteName = siteDoc?.Name || (updatedEquipment.Site ? `Site_${updatedEquipment.Site}` : null);
      const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, updatedEquipment.EqID);
      // Make sure target prefix exists (for brand new destinations)
      try {
        await azureBlob.uploadBuffer(`${eqPrefix}/.keep`, Buffer.alloc(0), 'application/octet-stream', {
          metadata: { kind: 'eq-keep' }
        });
      } catch {}
      const pictures = [];
      for (const file of files) {
        const cleanName = cleanFileName(file.originalname.split('__')[1] || file.originalname);
        const blobPath = `${eqPrefix}/${cleanName}`;
        const guessedType = file.mimetype || mime.lookup(cleanName) || 'application/octet-stream';
        await azureBlob.uploadFile(file.path, blobPath, guessedType);
        pictures.push({
          name: cleanName,
          blobPath,
          blobUrl: azureBlob.getBlobUrl(blobPath),
          contentType: guessedType,
          size: file.size,
          uploadedAt: new Date()
        });
        try { fs.unlinkSync(file.path); } catch {}
      }
      updatedEquipment.Pictures = [...(updatedEquipment.Pictures || []), ...pictures];
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
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó tenant.' });
    }
    const tenantName = req.scope?.tenantName || '';
    const equipment = await Equipment.findOne({ _id: id, tenantId });
    if (!equipment) {
      return res.status(404).json({ error: 'Az eszköz nem található vagy nem tartozik a vállalatához.' });
    }
    let zoneDoc = null;
    let siteDoc = null;
    if (equipment.Zone && equipment.Site) {
      zoneDoc = await Zone.findById(equipment.Zone).lean();
      siteDoc = await Site.findById(equipment.Site).lean();
    }
    const zoneName = zoneDoc?.Name || (equipment.Zone ? `Zone_${equipment.Zone}` : null);
    const siteName = siteDoc?.Name || (equipment.Site ? `Site_${equipment.Site}` : null);
    const eqPrefix = buildEquipmentPrefix(tenantName, tenantId, siteName, zoneName, equipment.EqID);
    try { await azureBlob.deletePrefix(`${eqPrefix}/`); } catch (e) { console.warn('⚠️ deletePrefix failed:', e?.message); }
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
      const tenantId = req.scope?.tenantId;
      if (!tenantId) return res.status(401).json({ error: 'Missing tenantId' });
      const manufacturers = await Equipment.distinct('Manufacturer', { tenantId });
      res.json(manufacturers);
  } catch (error) {
      console.error('Error fetching manufacturers:', error);
      res.status(500).json({ error: 'Server error while fetching manufacturers.' });
  }
};