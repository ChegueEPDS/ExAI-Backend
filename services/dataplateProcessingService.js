const azureBlob = require('./azureBlobService');
const { ocrImageBufferToDataplatePrompt } = require('../helpers/azureVisionOcr');
const { extractDataplateFieldsFromOcrText } = require('../helpers/dataplateJsonExtractor');
const { normalizeProtectionTypes } = require('../helpers/protectionTypes');
const tenantSettingsStore = require('./tenantSettingsStore');
const { ensureRbSchema } = require('./schemaSeedService');
const { attachEquipmentMarkings, equipmentMarkings, getRbValues, ensureRbAssignment } = require('./rbSchemaValueService');

function pickFirstDataplateImage(equipmentDoc) {
  const docs = Array.isArray(equipmentDoc?.documents) ? equipmentDoc.documents : [];
  const pics = Array.isArray(equipmentDoc?.Pictures) ? equipmentDoc.Pictures : [];

  const docDp = docs.find((d) => String(d?.tag || '').toLowerCase() === 'dataplate' && (d.blobPath || d.blobUrl));
  if (docDp) return { blobPath: docDp.blobPath || docDp.blobUrl, source: 'documents' };

  const picDp = pics.find((p) => String(p?.tag || '').toLowerCase() === 'dataplate' && (p.blobPath || p.blobUrl));
  if (picDp) return { blobPath: picDp.blobPath || picDp.blobUrl, source: 'pictures' };

  return null;
}

function coerceCompliance(v) {
  const s = String(v || '').trim();
  if (s === 'Passed' || s === 'Failed' || s === 'NA') return s;
  const lower = s.toLowerCase();
  if (lower.startsWith('pass')) return 'Passed';
  if (lower.startsWith('fail')) return 'Failed';
  if (lower === 'na') return 'NA';
  return null;
}

function setIfEmpty(doc, field, value) {
  const next = String(value || '').trim();
  if (!next) return false;
  const cur = doc[field];
  if (cur == null) {
    doc[field] = next;
    return true;
  }
  if (typeof cur === 'string' && cur.trim() === '') {
    doc[field] = next;
    return true;
  }
  return false;
}

function setNestedIfEmpty(doc, field, value) {
  // for schema fields with spaces (e.g. 'Model/Type')
  const next = String(value || '').trim();
  if (!next) return false;
  const cur = doc.get ? doc.get(field) : doc[field];
  if (cur == null || (typeof cur === 'string' && cur.trim() === '')) {
    if (doc.set) doc.set(field, next);
    else doc[field] = next;
    return true;
  }
  return false;
}

async function processDataplateForEquipment({ equipmentDoc, tenantId, tenantKey, userId }) {
  const target = pickFirstDataplateImage(equipmentDoc);
  if (!target) {
    return { processed: false, reason: 'no_dataplate_image' };
  }

  const buffer = await azureBlob.downloadToBuffer(target.blobPath);
  const parsed = await extractDataplateFieldsFromImageBuffer({ buffer, tenantId });
  if (!parsed) return { processed: false, reason: 'llm_extract_failed' };

  return applyDataplateFieldsToEquipment({ equipmentDoc, parsed, userId, source: target.source });
}

async function extractDataplateFieldsFromImageBuffer({ buffer, tenantId }) {
  const { formattedText, recognizedText } = await ocrImageBufferToDataplatePrompt(buffer);

  // Prefer structured extraction (Responses json_schema) for accuracy + deterministic validation.
  let parsed = null;
  try {
    const cfg = tenantId
      ? await tenantSettingsStore.getDataplateExtractConfig(tenantId)
      : { model: 'gpt-4o-mini', extraInstructions: '' };
    const mergedInstructions = String(cfg?.extraInstructions || '').trim();
    const r = await extractDataplateFieldsFromOcrText({
      ocrText: formattedText || recognizedText || '',
      model: String(cfg?.model || 'gpt-4o-mini'),
      assistantInstructions: mergedInstructions,
    });
    if (r.ok) {
      parsed = r.fields;
    }
  } catch {
    parsed = null;
  }

  if (!parsed) return null;

  // Normalize "Type of Protection" to the supported set used by questions/inspections.
  if (Array.isArray(parsed['Ex Marking'])) {
    parsed['Ex Marking'] = parsed['Ex Marking'].map((m) => {
      const normalized = normalizeProtectionTypes(m?.['Type of Protection']);
      const next = { ...(m || {}) };
      if (normalized.length) {
        next['Type of Protection'] = normalized.join('; ');
      } else if (typeof next['Type of Protection'] === 'string') {
        // don't keep un-parseable free text
        next['Type of Protection'] = '';
      }
      return next;
    });
  }

  return parsed;
}

async function applyDataplateFieldsToEquipment({ equipmentDoc, parsed, userId, source }) {
  let changed = false;
  changed = setNestedIfEmpty(equipmentDoc, 'Manufacturer', parsed.Manufacturer) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Model/Type', parsed['Model/Type']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Serial Number', parsed['Serial Number']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Equipment Type', parsed['Equipment Type']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'IP rating', parsed['IP rating']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Max Ambient Temp', parsed['Max Ambient Temp']) || changed;

  // Other Info: append only if equipment Other Info is empty (avoid overriding user notes)
  changed = setNestedIfEmpty(equipmentDoc, 'Other Info', parsed['Other Info']) || changed;

  // RB Ex marking is stored under schemaAssignments; only fill missing cells.
  const currentMarks = equipmentMarkings(equipmentDoc);
  const hasMarks = currentMarks.length > 0;
  const parsedMarks = Array.isArray(parsed['Ex Marking']) ? parsed['Ex Marking'] : [];
  if (parsedMarks.length) {
    const rbSchema = await ensureRbSchema();
    if (!hasMarks) {
      attachEquipmentMarkings(equipmentDoc, rbSchema, parsedMarks, userId || null);
      changed = true;
    } else {
      const existingMarks = Array.isArray(currentMarks) ? [...currentMarks] : [];
      const existingFirst = existingMarks[0] && typeof existingMarks[0] === 'object' ? existingMarks[0] : {};
      const parsedFirst = parsedMarks[0] && typeof parsedMarks[0] === 'object' ? parsedMarks[0] : {};
      const nextFirst = { ...existingFirst };

      Object.keys(parsedFirst).forEach((k) => {
        const cur = String(nextFirst[k] || '').trim();
        const nxt = String(parsedFirst[k] || '').trim();
        if (!cur && nxt) nextFirst[k] = parsedFirst[k];
      });

      existingMarks[0] = nextFirst;
      attachEquipmentMarkings(equipmentDoc, rbSchema, existingMarks, userId || null);
      changed = true;
    }
  }

  const rbValues = { ...getRbValues(equipmentDoc) };
  const parsedCertificateNo = String(parsed['Certificate No'] || '').trim();
  if (parsedCertificateNo && !String(rbValues.certificateNo || '').trim()) {
    rbValues.certificateNo = parsedCertificateNo;
    const rbSchema = await ensureRbSchema();
    ensureRbAssignment(equipmentDoc, rbSchema, rbValues, userId || null);
    changed = true;
  }

  // Compliance from assistant only if current RB compliance is NA/missing.
  const compliance = coerceCompliance(parsed.Compliance);
  const currentCompliance = String(getRbValues(equipmentDoc).compliance || 'NA');
  if (compliance && currentCompliance === 'NA') {
    const rbSchema = await ensureRbSchema();
    ensureRbAssignment(equipmentDoc, rbSchema, { ...getRbValues(equipmentDoc), compliance }, userId || null);
    changed = true;
  }

  if (changed) {
    if (equipmentDoc.markModified) equipmentDoc.markModified('schemaAssignments');
    if (userId) {
      equipmentDoc.ModifiedBy = userId;
    }
    await equipmentDoc.save();
  }

  return { processed: true, changed, source };
}

module.exports = { processDataplateForEquipment, extractDataplateFieldsFromImageBuffer };
