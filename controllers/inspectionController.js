// controllers/inspectionController.js
const path = require('path');
const Inspection = require('../models/inspection');
const Equipment = require('../models/dataplate');
const mongoose = require('mongoose');
const multer = require('multer');
const azureBlob = require('../services/azureBlobService');
const Question = require('../models/questions');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const { buildCertificateCacheForTenant, resolveCertificateFromCache } = require('../helpers/certificateMatchHelper');
const { KNOWN_SET_LOWER, normalizeProtectionTypes } = require('../helpers/protectionTypes');

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

function computeFailureSeverity(results = []) {
  // Highest severity wins: P1 > P2 > P3 > P4
  const rank = { P1: 4, P2: 3, P3: 2, P4: 1 };
  let best = null;
  let bestRank = 0;

  for (const r of results || []) {
    if (!r || r.status !== 'Failed') continue;
    const sev = String(r.severity || '').toUpperCase();
    const rnk = rank[sev] || 0;
    if (rnk > bestRank) {
      bestRank = rnk;
      best = sev;
    }
  }

  return best && ['P1', 'P2', 'P3', 'P4'].includes(best) ? best : null;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractProtectionTokens(equipmentDoc) {
  const protection = equipmentDoc?.['Ex Marking']?.[0]?.['Type of Protection'] || '';
  if (!protection) return [];
  const tokens = normalizeProtectionTypes(protection).map((v) => String(v).trim().toLowerCase());
  const hasKnown = tokens.some((t) => KNOWN_SET_LOWER.has(t));
  if (!hasKnown && tokens.length) {
    return Array.from(new Set(['d', 'e', ...tokens]));
  }
  return tokens;
}

async function computeRelevantEquipmentTypes(equipmentDoc, tenantId) {
  const rawType =
    (equipmentDoc && typeof equipmentDoc === 'object'
      ? equipmentDoc['Equipment Type'] || equipmentDoc.EquipmentType || ''
      : '') || '';
  const normalized = String(rawType).toLowerCase().trim();
  const result = new Set();
  if (!normalized) return result;

  const tenantObjectId = tenantId && mongoose.Types.ObjectId.isValid(tenantId) ? new mongoose.Types.ObjectId(tenantId) : null;
  if (!tenantObjectId) return result;

  const mappings = await QuestionTypeMapping.find({ tenantId: tenantObjectId, active: true })
    .select('equipmentPattern equipmentTypes')
    .lean();
  (mappings || []).forEach((m) => {
    const pattern = String(m.equipmentPattern || '').toLowerCase().trim();
    if (!pattern) return;
    if (!normalized.includes(pattern)) return;
    (m.equipmentTypes || []).forEach((t) => {
      if (!t) return;
      result.add(String(t).toLowerCase());
    });
  });
  return result;
}

async function buildSpecialConditionResultFromEquipment(equipmentDoc, tenantId) {
  const equipmentSpecific =
    (equipmentDoc &&
    typeof equipmentDoc === 'object' &&
    equipmentDoc['X condition'] &&
    typeof equipmentDoc['X condition'].Specific === 'string'
      ? equipmentDoc['X condition'].Specific
      : '').trim();

  let text = equipmentSpecific;
  if (!text) {
    const certNo = equipmentDoc?.['Certificate No'] || equipmentDoc?.CertificateNo;
    if (certNo) {
      const certMap = await buildCertificateCacheForTenant(tenantId);
      const cert = resolveCertificateFromCache(certMap, String(certNo));
      text = (cert?.specCondition || '').trim();
    }
  }
  if (!text) return null;

  return {
    questionId: undefined,
    table: 'SC',
    group: 'SC',
    number: 1,
    equipmentType: 'Special Condition',
    protectionTypes: [],
    status: 'Passed',
    note: '',
    questionText: { eng: text, hun: '' }
  };
}

async function generateInspectionResultsForEquipment({ equipmentDoc, tenantId, inspectionType }) {
  const protections = extractProtectionTokens(equipmentDoc);
  const filter = {};
  const tenantObjectId = tenantId && mongoose.Types.ObjectId.isValid(tenantId) ? new mongoose.Types.ObjectId(tenantId) : null;
  if (tenantObjectId) filter.tenantId = tenantObjectId;
  if (protections.length) {
    filter.protectionTypes = { $in: protections.map((t) => new RegExp(`^${escapeRegex(t)}$`, 'i')) };
  }

  let questions = await Question.find(filter).lean();
  if ((!questions || !questions.length) && tenantObjectId) {
    const fallbackFilter = { ...filter };
    delete fallbackFilter.tenantId;
    questions = await Question.find(fallbackFilter).lean();
  }

  const relevantTypes = await computeRelevantEquipmentTypes(equipmentDoc, tenantId);
  const basePassedTypes = new Set(['general', 'environment', 'additional checks']);

  let results = (questions || [])
    .filter((q) => {
      const types = Array.isArray(q.inspectionTypes) ? q.inspectionTypes : [];
      return !types.length || types.includes(inspectionType);
    })
    .map((q) => {
      const eqType = (q.equipmentType || '').toLowerCase();
      const shouldBePassed = basePassedTypes.has(eqType) || relevantTypes.has(eqType);
      return {
        questionId: q._id ? new mongoose.Types.ObjectId(q._id) : undefined,
        table: q.table || q.Table || '',
        group: q.group || q.Group || '',
        number: q.number ?? q.Number ?? null,
        equipmentType: q.equipmentType || '',
        protectionTypes: Array.isArray(q.protectionTypes) ? q.protectionTypes : [],
        status: shouldBePassed ? 'Passed' : 'NA',
        note: '',
        questionText: { eng: q.questionText?.eng || '', hun: q.questionText?.hun || '' }
      };
    });

  const sc = await buildSpecialConditionResultFromEquipment(equipmentDoc, tenantId);
  if (sc) results.push(sc);
  return results;
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
      severity: r.status === 'Failed' ? (r.severity ? String(r.severity).toUpperCase() : null) : null,
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
    const failureSeverity = status === 'Failed' ? computeFailureSeverity(normalizedResults) : null;

    // ---- Inspection dokumentum létrehozása ----
    const inspection = new Inspection({
      equipmentId: equipment._id,
      eqId: eqIdString,
      tenantId,
      siteId: equipment.Site || null,
      zoneId: equipment.Unit || equipment.Zone || null,
      inspectionDate: new Date(inspectionDate),
      validUntil: new Date(validUntil),
      inspectionType,
      inspectorId,
      results: normalizedResults,
      attachments: normalizedAttachments,
      summary,
      status,
      failureSeverity,
      reviewStatus: 'final',
      source: 'manual',
      finalizedAt: new Date(),
      finalizedBy: inspectorId
    });

    await inspection.save();

    // ---- Equipment "összegző" mezők frissítése ----
    try {
      // FIGYELEM: ehhez érdemes a dataplate/Equipment sémát kiegészíteni
      // lastInspectionDate, lastInspectionValidUntil, lastInspectionStatus, lastInspectionId mezőkkel.
      equipment.Compliance = status; // ahogy eddig is
      equipment.lastInspectionDate = inspection.inspectionDate;
      // Failed inspectionnek nincs "next inspection date"-je (UI: ne jelenjen meg PLANNED).
      equipment.lastInspectionValidUntil = status === 'Failed' ? null : inspection.validUntil;
      equipment.lastInspectionStatus = status;
      equipment.lastInspectionId = inspection._id;
      // Any finalized inspection clears "pending review" flags (mobile-sync or post-maintenance).
      equipment.pendingReview = false;
      equipment.pendingInspectionId = null;

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

exports.updateInspection = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.userId;
    const { id } = req.params;
    if (!tenantId) return res.status(400).json({ message: 'tenantId is missing from auth' });
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid inspection id.' });

    const inspection = await Inspection.findOne({ _id: id, tenantId });
    if (!inspection) return res.status(404).json({ message: 'Inspection not found.' });

    const {
      inspectionDate,
      validUntil,
      inspectionType,
      results = [],
      attachments = [],
      finalize = false
    } = req.body || {};

    const finalizedNow = finalize ? new Date() : null;
    const effectiveInspectionDate = finalize
      ? (finalizedNow || new Date())
      : (inspectionDate ? new Date(inspectionDate) : null);
    const effectiveValidUntil = finalize
      ? (() => {
        const d = new Date(effectiveInspectionDate);
        d.setFullYear(d.getFullYear() + 3);
        return d;
      })()
      : (validUntil ? new Date(validUntil) : null);

    if (!effectiveInspectionDate || !effectiveValidUntil) {
      return res.status(400).json({ message: 'inspectionDate és validUntil kötelező mezők.' });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ message: 'results mezőnek legalább egy kérdést tartalmaznia kell.' });
    }

    const normalizedResults = results.map(r => ({
      questionId: r.questionId ? new mongoose.Types.ObjectId(r.questionId) : undefined,
      table: r.table || r.Table || undefined,
      group: r.group || r.Group || undefined,
      number: r.number ?? r.Number,
      equipmentType: r.equipmentType || undefined,
      protectionTypes: Array.isArray(r.protectionTypes) ? r.protectionTypes : [],
      status: r.status,
      note: r.note || '',
      severity: r.status === 'Failed' ? (r.severity ? String(r.severity).toUpperCase() : null) : null,
      questionText: {
        eng: r.questionText?.eng || r.questionText?.EN || r.questionText?.En || '',
        hun: r.questionText?.hun || r.questionText?.HU || r.questionText?.Hu || ''
      }
    }));

    const normalizedAttachments = (attachments || []).map(a => ({
      blobPath: a.blobPath,
      blobUrl: a.blobUrl,
      type: a.type || 'image',
      contentType: a.contentType || (a.type === 'image' ? 'image/*' : 'application/octet-stream'),
      size: a.size ?? null,
      questionId: a.questionId ? new mongoose.Types.ObjectId(a.questionId) : undefined,
      questionKey: a.questionKey || undefined,
      note: a.note || '',
      createdBy: userId
    }));

    const { summary, status } = buildSummaryAndStatus(normalizedResults);
    const failureSeverity = status === 'Failed' ? computeFailureSeverity(normalizedResults) : null;

    // When finalizing a pending inspection, the inspectionDate must reflect the close time
    // so it naturally appears at the top of the timeline.
    inspection.inspectionDate = effectiveInspectionDate;
    inspection.validUntil = effectiveValidUntil;
    inspection.inspectionType = inspectionType || inspection.inspectionType;
    inspection.results = normalizedResults;
    inspection.attachments = normalizedAttachments;
    inspection.summary = summary;
    inspection.status = status;
    inspection.failureSeverity = failureSeverity;

    if (finalize) {
      inspection.reviewStatus = 'final';
      inspection.finalizedAt = finalizedNow || new Date();
      inspection.finalizedBy = userId;
    }

    await inspection.save();

    if (finalize) {
      const equipment = await Equipment.findOne({ _id: inspection.equipmentId, tenantId });
      if (equipment) {
        equipment.lastInspectionDate = inspection.inspectionDate;
        equipment.lastInspectionValidUntil = inspection.status === 'Failed' ? null : inspection.validUntil;
        equipment.lastInspectionStatus = inspection.status;
        equipment.lastInspectionId = inspection._id;
        equipment.Compliance = inspection.status;
        equipment.pendingReview = false;
        equipment.pendingInspectionId = null;
        await equipment.save();
      }
    }

    return res.json(inspection);
  } catch (error) {
    console.error('❌ updateInspection failed:', error);
    return res.status(500).json({ message: 'Failed to update inspection.' });
  }
};

exports.regenerateInspection = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.userId;
    const { id } = req.params;
    if (!tenantId) return res.status(400).json({ message: 'tenantId is missing from auth' });
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid inspection id.' });

    const inspection = await Inspection.findOne({ _id: id, tenantId });
    if (!inspection) return res.status(404).json({ message: 'Inspection not found.' });
    if (String(inspection.reviewStatus || 'final') !== 'pending') {
      return res.status(400).json({ message: 'Only pending inspections can be regenerated.' });
    }

    const equipment = await Equipment.findOne({ _id: inspection.equipmentId, tenantId });
    if (!equipment) return res.status(404).json({ message: 'Equipment not found for inspection.' });

    const inspectionType = req.body?.inspectionType || inspection.inspectionType || 'Detailed';
    const generated = await generateInspectionResultsForEquipment({
      equipmentDoc: equipment,
      tenantId,
      inspectionType
    });

    const existingByQuestionId = new Map();
    (inspection.results || []).forEach((r) => {
      const idStr = r?.questionId ? String(r.questionId) : '';
      if (idStr) existingByQuestionId.set(idStr, r);
    });

    const merged = generated.map((r) => {
      const idStr = r?.questionId ? String(r.questionId) : '';
      const prev = idStr ? existingByQuestionId.get(idStr) : null;
      if (!prev) return r;
      return { ...r, status: prev.status, note: prev.note || '', severity: prev.severity ?? null };
    });

    const { summary, status } = buildSummaryAndStatus(merged);
    const failureSeverity = status === 'Failed' ? computeFailureSeverity(merged) : null;
    inspection.results = merged;
    inspection.summary = summary;
    inspection.status = status;
    inspection.failureSeverity = failureSeverity;
    inspection.inspectionType = inspectionType;
    await inspection.save();

    return res.json(inspection);
  } catch (error) {
    console.error('❌ regenerateInspection failed:', error);
    return res.status(500).json({ message: 'Failed to regenerate inspection.' });
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
      .populate('equipmentId', 'EqID Manufacturer "Model/Type" Unit Zone Site')
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
              equipment.lastInspectionValidUntil = latest.status === 'Failed' ? null : latest.validUntil;
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
