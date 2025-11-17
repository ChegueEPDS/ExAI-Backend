// controllers/inspectionController.js
const Inspection = require('../models/inspection');
const Equipment = require('../models/dataplate');
const mongoose = require('mongoose');

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
      .sort({ inspectionDate: -1, createdAt: -1 })
      .lean();

    return res.json(inspections);
  } catch (error) {
    console.error('❌ Hiba az inspectionök listázása közben:', error);
    return res.status(500).json({ message: 'Belső szerverhiba az inspectionök listázásakor.' });
  }
};