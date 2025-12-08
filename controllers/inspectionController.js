// controllers/inspectionController.js
const path = require('path');
const Inspection = require('../models/inspection');
const Equipment = require('../models/dataplate');
const mongoose = require('mongoose');
const multer = require('multer');
const azureBlob = require('../services/azureBlobService');

const upload = multer({ dest: 'uploads/' });

/**
 * Segédfüggvény: összefoglaló statisztika számítása
 * - hány Passed / Failed / NA kérdés volt
 * - globális státusz: ha van Failed → Failed, különben Passed
 */
function buildSummaryAndStatus(results = []) {
  let failedCount = 0;
  let naCount = 0;
  let passedCount = 0;

  for (const r of results) {
    if (r.status === 'Failed') failedCount++;
    else if (r.status === 'NA') naCount++;
    else if (r.status === 'Passed') passedCount++;
  }

  const status = failedCount > 0 ? 'Failed' : 'Passed';

  return {
    summary: { failedCount, naCount, passedCount },
    status
  };
}

/**
 * POST /api/inspections
 * Új inspection mentése
 *
 * Várható body (minimum):
 * {
 *   equipmentId?: string,  // Mongo _id
 *   eqId?: string,         // EqID string, ha equipmentId nincs
 *   inspectionDate: string/Date,
 *   validUntil: string/Date,
 *   results: [
 *     {
 *       questionId?: string,
 *       table?: string,
 *       group?: string,
 *       number?: number,
 *       equipmentType?: string,
 *       protectionTypes?: string[],
 *       status: 'Passed' | 'Failed' | 'NA',
 *       note?: string,
 *       questionText?: { eng?: string, hun?: string }
 *     }
 *   ],
 *   attachments?: [
 *     {
 *       blobPath: string,
 *       blobUrl: string,
 *       type?: 'image' | 'document',
 *       questionId?: string,
 *       questionKey?: string,
 *       note?: string
 *     }
 *   ]
 * }
 */
exports.createInspection = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const inspectorId = req.userId; // ugyanaz, mint CreatedBy a többi controllerben

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }
    if (!inspectorId) {
      return res.status(401).json({ message: 'Nincs bejelentkezett felhasználó (inspector).' });
    }

    const {
      equipmentId,
      eqId,
      inspectionDate,
      validUntil,
      inspectionType,
      results = [],
      attachments = []
    } = req.body || {};

    if (!inspectionDate || !validUntil) {
      return res.status(400).json({ message: 'inspectionDate és validUntil kötelező mezők.' });
    }

    if (!equipmentId && !eqId) {
      return res.status(400).json({ message: 'equipmentId vagy eqId megadása kötelező.' });
    }

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ message: 'results mezőnek legalább egy kérdést tartalmaznia kell.' });
    }

    // ---- Megfelelő eszköz kikeresése (tenant szűréssel) ----
    let equipment;
    if (equipmentId && mongoose.isValidObjectId(equipmentId)) {
      equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    } else if (eqId) {
      equipment = await Equipment.findOne({ EqID: eqId, tenantId });
    }

    if (!equipment) {
      return res.status(404).json({ message: 'Nem található eszköz a megadott azonosítóval.' });
    }

    // EqID string biztosítása
    const eqIdString = equipment.EqID || eqId;

    // ---- Eredmények normalizálása ----
    const normalizedResults = results.map(r => ({
      questionId: r.questionId ? new mongoose.Types.ObjectId(r.questionId) : undefined,
      table: r.table || r.Table || undefined,
      group: r.group || r.Group || undefined,
      number: r.number ?? r.Number,
      equipmentType: r.equipmentType || undefined,
      protectionTypes: Array.isArray(r.protectionTypes)
        ? r.protectionTypes
        : [],
      status: r.status, // 'Passed' | 'Failed' | 'NA'
      note: r.note || '',
      questionText: {
        eng: r.questionText?.eng || r.questionText?.EN || r.questionText?.En || '',
        hun: r.questionText?.hun || r.questionText?.HU || r.questionText?.Hu || ''
      }
    }));

    // ---- Attachments normalizálása ----
    const normalizedAttachments = (attachments || []).map(a => ({
      blobPath: a.blobPath,
      blobUrl: a.blobUrl,
      type: a.type || 'image',
      contentType: a.contentType || (a.type === 'image' ? 'image/*' : 'application/octet-stream'),
      size: a.size ?? null,
      questionId: a.questionId ? new mongoose.Types.ObjectId(a.questionId) : undefined,
      questionKey: a.questionKey || undefined,
      note: a.note || '',
      createdBy: inspectorId
    }));

    // ---- Összefoglaló és globális státusz számítása ----
    const { summary, status } = buildSummaryAndStatus(normalizedResults);

    // ---- Inspection dokumentum létrehozása ----
    const inspection = new Inspection({
      equipmentId: equipment._id,
      eqId: eqIdString,
      tenantId,
      siteId: equipment.Site || null,
      zoneId: equipment.Zone || null,
      inspectionDate: new Date(inspectionDate),
      validUntil: new Date(validUntil),
      inspectionType,
      inspectorId,
      results: normalizedResults,
      attachments: normalizedAttachments,
      summary,
      status
    });

    await inspection.save();

    // ---- Equipment "összegző" mezők frissítése ----
    try {
      // FIGYELEM: ehhez érdemes a dataplate/Equipment sémát kiegészíteni
      // lastInspectionDate, lastInspectionValidUntil, lastInspectionStatus, lastInspectionId mezőkkel.
      equipment.Compliance = status; // ahogy eddig is
      equipment.lastInspectionDate = inspection.inspectionDate;
      equipment.lastInspectionValidUntil = inspection.validUntil;
      equipment.lastInspectionStatus = status;
      equipment.lastInspectionId = inspection._id;

      const imageAttachments = normalizedAttachments.filter(att => att.type === 'image' && att.blobPath && att.blobUrl);
      if (imageAttachments.length) {
        const existingPaths = new Set(
          Array.isArray(equipment.documents)
            ? equipment.documents.map(doc => doc.blobPath)
            : []
        );
        const docsToAppend = [];
        imageAttachments.forEach(att => {
          if (existingPaths.has(att.blobPath)) return;
          docsToAppend.push({
            name: att.blobPath.split('/').pop() || 'inspection-image',
            alias: att.note || '',
            type: 'image',
            blobPath: att.blobPath,
            blobUrl: att.blobUrl,
            contentType: att.contentType || 'image/*',
            size: att.size ?? null,
            uploadedAt: new Date(),
            tag: 'fault'
          });
          existingPaths.add(att.blobPath);
        });
        if (docsToAppend.length) {
          equipment.documents = [...(equipment.documents || []), ...docsToAppend];
        }
      }

      await equipment.save();
    } catch (updateErr) {
      console.error('⚠️ Warning: Nem sikerült az eszköz lastInspection mezőinek frissítése:', updateErr);
      // Itt nem dobunk hibát a kliensnek, mert az inspection már elment.
    }

    return res.status(201).json(inspection);
  } catch (error) {
    console.error('❌ Hiba az inspection létrehozása közben:', error);
    return res.status(500).json({ message: 'Belső szerverhiba az inspection létrehozásakor.' });
  }
};

/**
 * GET /api/inspections/:id
 * Egy konkrét inspection lekérése részletesen
 */
exports.getInspectionById = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Érvénytelen inspection ID.' });
    }

    const inspection = await Inspection.findOne({ _id: id, tenantId })
      .populate('equipmentId', 'EqID Manufacturer "Model/Type" Zone Site')
      .populate('inspectorId', 'name email');

    if (!inspection) {
      return res.status(404).json({ message: 'Inspection nem található.' });
    }

    return res.json(inspection);
  } catch (error) {
    console.error('❌ Hiba az inspection lekérése közben:', error);
    return res.status(500).json({ message: 'Belső szerverhiba az inspection lekérésekor.' });
  }
};

/**
 * GET /api/inspections
 * Inspectionök listázása szűrőkkel:
 *  - equipmentId
 *  - eqId
 *  - siteId
 *  - zoneId
 *  - status (Passed / Failed)
 *  - from / to (inspectionDate intervallum)
 */
exports.listInspections = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    const {
      equipmentId,
      eqId,
      siteId,
      zoneId,
      status,
      from,
      to
    } = req.query;

    const filter = { tenantId };

    if (equipmentId && mongoose.isValidObjectId(equipmentId)) {
      filter.equipmentId = equipmentId;
    }

    if (eqId) {
      filter.eqId = eqId;
    }

    if (siteId && mongoose.isValidObjectId(siteId)) {
      filter.siteId = siteId;
    }

    if (zoneId && mongoose.isValidObjectId(zoneId)) {
      filter.zoneId = zoneId;
    }

    if (status && (status === 'Passed' || status === 'Failed')) {
      filter.status = status;
    }

    if (from || to) {
      filter.inspectionDate = {};
      if (from) {
        filter.inspectionDate.$gte = new Date(from);
      }
      if (to) {
        filter.inspectionDate.$lte = new Date(to);
      }
    }

    const inspections = await Inspection.find(filter)
      .populate('inspectorId', 'firstName lastName email')
      .sort({ inspectionDate: -1, createdAt: -1 })
      .lean();

    return res.json(inspections);
  } catch (error) {
    console.error('❌ Hiba az inspectionök listázása közben:', error);
    return res.status(500).json({ message: 'Belső szerverhiba az inspectionök listázásakor.' });
  }
};

/**
 * POST /api/inspections/upload-attachment
 * Form fields:
 *  - file (multipart)
 *  - eqId (required) – Equipment EqID string (used for blob path)
 *  - questionId (optional)
 *  - questionKey (optional) e.g. "T1-G2-3" or "SC1"
 *  - note (optional)
 */
exports.uploadInspectionAttachment = (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('❌ Attachment upload failed:', err);
      return res.status(500).json({ message: 'Attachment upload failed' });
    }

    const file = req.file;
    const { eqId, questionId, questionKey, note } = req.body || {};
    const tenantId = req.scope?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!file) {
      return res.status(400).json({ message: 'Missing file' });
    }

    if (!eqId) {
      return res.status(400).json({ message: 'eqId is required' });
    }

    try {
      const safeEq = String(eqId).replace(/[^\w\-.]+/g, '_');
      const originalName = file.originalname || `inspection_${Date.now()}`;
      const ext = path.extname(originalName) || '';
      let baseName = originalName.replace(/[^\w.\-]+/g, '_').replace(ext, '');
      const normalizedRef = questionKey ? String(questionKey).trim() : '';
      let alias = note || '';
      if (normalizedRef) {
        const safeRef = normalizedRef.replace(/[^A-Za-z0-9_-]+/g, '_');
        baseName = `Failure-${safeRef || Date.now()}`;
        if (!alias) alias = `Failure - ${normalizedRef}`;
      }
      const cleanName = `${baseName}${ext}`;
      const blobPath = `Equipment/${safeEq}/inspections/${Date.now()}_${cleanName}`;
      const guessedType = file.mimetype || 'application/octet-stream';

      await azureBlob.uploadFile(file.path, blobPath, guessedType);

      const blobUrl = azureBlob.getBlobUrl(blobPath);

      try { require('fs').unlinkSync(file.path); } catch (_) {}

      return res.status(200).json({
        blobPath,
        blobUrl,
        type: guessedType.startsWith('image') ? 'image' : 'document',
        contentType: guessedType,
        size: file.size,
        questionId: questionId || undefined,
        questionKey: questionKey || undefined,
        note: alias || ''
      });
    } catch (uploadErr) {
      console.error('❌ Attachment upload error:', uploadErr);
      return res.status(500).json({ message: 'Failed to upload attachment', error: uploadErr.message });
    }
  });
};

/**
 * DELETE /api/inspections/attachment
 * Body: { blobPath: string }
 * Best-effort: if blobPath missing or delete fails, respond with 400/500.
 */
exports.deleteInspectionAttachment = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    const blobPath = req.body?.blobPath;
    if (!blobPath || typeof blobPath !== 'string') {
      return res.status(400).json({ message: 'blobPath is required' });
    }

    // Opció: biztosítsuk, hogy csak Equipment mappán belül törlünk
    if (!blobPath.startsWith('Equipment/')) {
      return res.status(400).json({ message: 'Invalid blobPath' });
    }

    if (typeof azureBlob.deleteFile !== 'function') {
      return res.status(500).json({ message: 'Blob delete not available' });
    }

    await azureBlob.deleteFile(blobPath);
    return res.status(200).json({ message: 'Attachment deleted', blobPath });
  } catch (error) {
    console.error('❌ Failed to delete inspection attachment:', error);
    return res.status(500).json({ message: 'Failed to delete attachment', error: error.message });
  }
};

/**
 * DELETE /api/inspections/:id
 * Egy teljes inspection törlése:
 *  - az Inspection dokumentum törlése
 *  - az ahhoz tartozó blob képek/dokumentumok törlése
 *  - az Equipment dokumentumból az ezekre hivatkozó dokumentum-bejegyzések eltávolítása
 *  - ha ez volt a legutóbbi inspection, az összefoglaló mezők újraszámítása
 */
exports.deleteInspection = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId is missing from auth' });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Érvénytelen inspection ID.' });
    }

    const inspection = await Inspection.findOne({ _id: id, tenantId });
    if (!inspection) {
      return res.status(404).json({ message: 'Inspection nem található.' });
    }

    // 1) Blob képek/dokumentumok törlése (minden egyedi blobPath alapján)
    const blobPaths = new Set();
    (inspection.attachments || []).forEach(att => {
      const raw = att?.blobPath || att?.blobUrl;
      const normalized = raw ? azureBlob.toBlobPath(raw) : '';
      if (normalized) {
        blobPaths.add(normalized);
      }
    });

    for (const blobPath of blobPaths) {
      try {
        if (typeof azureBlob.deleteFile === 'function') {
          await azureBlob.deleteFile(blobPath);
        }
      } catch (err) {
        try {
          console.warn('⚠️ Failed to delete blob for inspection:', { blobPath, error: err?.message || err });
        } catch {}
      }
    }

    // 2) Inspection dokumentum törlése
    await Inspection.deleteOne({ _id: inspection._id });

    // 3) Equipment dokumentum frissítése (dokumentum-lista + lastInspection mezők)
    try {
      if (inspection.equipmentId && mongoose.isValidObjectId(inspection.equipmentId)) {
        const equipment = await Equipment.findOne({ _id: inspection.equipmentId, tenantId });
        if (equipment) {
          // Dokumentumok közül is szedjük ki ezeket a blobPath-okat
          if (Array.isArray(equipment.documents) && blobPaths.size > 0) {
            equipment.documents = equipment.documents.filter(doc => {
              const raw = doc?.blobPath || doc?.blobUrl;
              const normalized = raw ? azureBlob.toBlobPath(raw) : '';
              return !normalized || !blobPaths.has(normalized);
            });
          }

          // Ha ez volt a lastInspectionId, akkor újraszámoljuk a legfrissebb inspection alapján
          if (equipment.lastInspectionId && String(equipment.lastInspectionId) === String(inspection._id)) {
            const latest = await Inspection.findOne({
              equipmentId: equipment._id,
              tenantId
            })
              .sort({ inspectionDate: -1, createdAt: -1 })
              .lean();

            if (latest) {
              equipment.Compliance = latest.status;
              equipment.lastInspectionDate = latest.inspectionDate;
              equipment.lastInspectionValidUntil = latest.validUntil;
              equipment.lastInspectionStatus = latest.status;
              equipment.lastInspectionId = latest._id;
            } else {
              equipment.Compliance = 'NA';
              equipment.lastInspectionDate = null;
              equipment.lastInspectionValidUntil = null;
              equipment.lastInspectionStatus = null;
              equipment.lastInspectionId = null;
            }
          }

          await equipment.save();
        }
      }
    } catch (updateErr) {
      console.error('⚠️ Warning: Nem sikerült az eszköz frissítése inspection törlés után:', updateErr);
    }

    return res.json({ message: 'Inspection sikeresen törölve.', id });
  } catch (error) {
    console.error('❌ Hiba az inspection törlése közben:', error);
    return res.status(500).json({ message: 'Belső szerverhiba az inspection törlésekor.' });
  }
};
