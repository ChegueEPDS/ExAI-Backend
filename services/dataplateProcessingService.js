const azureBlob = require('./azureBlobService');
const { ocrImageBufferToDataplatePrompt } = require('../helpers/azureVisionOcr');
const { resolveAssistantIdByTenant } = require('./assistantRunner');
const { getAssistantInfoCached } = require('./chatPromptService');
const { extractDataplateFieldsFromOcrText } = require('../helpers/dataplateJsonExtractor');
const { runDataplateAssistant } = require('./assistantRunner'); // fallback only
const { buildEquipmentFromDataplateTable } = require('../helpers/htmlTableParser'); // fallback only
const { normalizeProtectionTypes } = require('../helpers/protectionTypes');

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

async function processDataplateForEquipment({ equipmentDoc, tenantKey, userId }) {
  const target = pickFirstDataplateImage(equipmentDoc);
  if (!target) {
    return { processed: false, reason: 'no_dataplate_image' };
  }

  const buffer = await azureBlob.downloadToBuffer(target.blobPath);
  const { formattedText, recognizedText } = await ocrImageBufferToDataplatePrompt(buffer);

  // Prefer structured extraction (Responses json_schema) for accuracy + deterministic validation.
  let parsed = null;
  try {
    const assistantId = resolveAssistantIdByTenant(String(tenantKey || '').toLowerCase());
    const assistantInfo = assistantId ? await getAssistantInfoCached(assistantId) : { instructions: '', model: null };
    const r = await extractDataplateFieldsFromOcrText({
      ocrText: formattedText || recognizedText || '',
      model: String(assistantInfo?.model || 'gpt-4o-mini'),
      assistantInstructions: String(assistantInfo?.instructions || ''),
    });
    if (r.ok) {
      parsed = r.fields;
    }
  } catch {
    parsed = null;
  }

  // Fallback (legacy): ask for an HTML table then parse it.
  if (!parsed) {
    const { html } = await runDataplateAssistant({ tenantKey, message: recognizedText });
    parsed = buildEquipmentFromDataplateTable(html);
    if (!parsed) {
      return { processed: false, reason: 'assistant_table_parse_failed' };
    }
  }

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

  let changed = false;
  changed = setNestedIfEmpty(equipmentDoc, 'Manufacturer', parsed.Manufacturer) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Model/Type', parsed['Model/Type']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Serial Number', parsed['Serial Number']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Equipment Type', parsed['Equipment Type']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'IP rating', parsed['IP rating']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Certificate No', parsed['Certificate No']) || changed;
  changed = setNestedIfEmpty(equipmentDoc, 'Max Ambient Temp', parsed['Max Ambient Temp']) || changed;

  // Other Info: append only if equipment Other Info is empty (avoid overriding user notes)
  changed = setNestedIfEmpty(equipmentDoc, 'Other Info', parsed['Other Info']) || changed;

  // Ex Marking: only set if currently empty
  const currentMarks = equipmentDoc.get ? equipmentDoc.get('Ex Marking') : equipmentDoc['Ex Marking'];
  const hasMarks = Array.isArray(currentMarks) && currentMarks.length > 0;
  const parsedMarks = Array.isArray(parsed['Ex Marking']) ? parsed['Ex Marking'] : [];
  if (parsedMarks.length) {
    if (!hasMarks) {
      if (equipmentDoc.set) equipmentDoc.set('Ex Marking', parsedMarks);
      else equipmentDoc['Ex Marking'] = parsedMarks;
      changed = true;
    } else {
      const existingMarks = Array.isArray(currentMarks) ? currentMarks : [];
      const existingFirst = existingMarks[0] && typeof existingMarks[0] === 'object' ? existingMarks[0] : {};
      const parsedFirst = parsedMarks[0] && typeof parsedMarks[0] === 'object' ? parsedMarks[0] : {};
      const nextFirst = { ...existingFirst };

      Object.keys(parsedFirst).forEach((k) => {
        const cur = String(nextFirst[k] || '').trim();
        const nxt = String(parsedFirst[k] || '').trim();
        if (!cur && nxt) nextFirst[k] = parsedFirst[k];
      });

      existingMarks[0] = nextFirst;
      if (equipmentDoc.set) equipmentDoc.set('Ex Marking', existingMarks);
      else equipmentDoc['Ex Marking'] = existingMarks;
      if (equipmentDoc.markModified) equipmentDoc.markModified('Ex Marking');
      changed = true;
    }
  }

  // Compliance from assistant only if current is NA
  const compliance = coerceCompliance(parsed.Compliance);
  if (compliance && String(equipmentDoc.Compliance || 'NA') === 'NA') {
    equipmentDoc.Compliance = compliance;
    changed = true;
  }

  if (changed) {
    if (userId) {
      equipmentDoc.ModifiedBy = userId;
    }
    await equipmentDoc.save();
  }

  return { processed: true, changed, source: target.source };
}

module.exports = { processDataplateForEquipment };
