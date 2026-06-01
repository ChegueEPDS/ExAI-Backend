function toPlain(entity) {
  if (!entity) return {};
  return typeof entity.toObject === 'function' ? entity.toObject() : entity;
}

function findRbAssignment(entity) {
  const doc = toPlain(entity);
  const assignments = Array.isArray(doc.schemaAssignments) ? doc.schemaAssignments : [];
  return assignments.find((a) => a?.schemaKey === 'rb') || null;
}

function getRbValues(entity) {
  return findRbAssignment(entity)?.values || {};
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function zoneView(entity) {
  const values = getRbValues(entity);
  return {
    Scheme: values.scheme || '',
    Environment: values.environment || '',
    Zone: listValue(values.zone).map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }),
    SubGroup: listValue(values.subGroup),
    TempClass: values.tempClass || '',
    MaxTemp: values.maxTemp ?? null,
    EPL: listValue(values.epl),
    AmbientTempMin: values.ambientTempMin ?? null,
    AmbientTempMax: values.ambientTempMax ?? null,
    clientReq: values.clientReq || values.clientRequirements || []
  };
}

function equipmentMarkings(entity) {
  const values = getRbValues(entity);
  if (Array.isArray(values.exMarking) && values.exMarking.length) return values.exMarking;
  if (!values.environment && !values.protectionTypes && !values.subGroup && !values.tempClass && !values.epl) return [];
  return [{
    Environment: values.environment || '',
    'Type of Protection': listValue(values.protectionTypes).join('; '),
    'Gas / Dust Group': listValue(values.subGroup).join('; '),
    'Temperature Class': values.tempClass || '',
    'Equipment Protection Level': listValue(values.epl).join('; ')
  }];
}

function primaryEquipmentMarking(entity) {
  return equipmentMarkings(entity)[0] || {};
}

function protectionText(entity) {
  return primaryEquipmentMarking(entity)?.['Type of Protection'] || '';
}

function certificateNo(entity) {
  const values = getRbValues(entity);
  return String(values.certificateNo || '').trim();
}

function complianceStatus(entity, fallback = 'NA') {
  const values = getRbValues(entity);
  return String(values.compliance || fallback || 'NA').trim() || 'NA';
}

function markingEnvironmentToRb(value) {
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  if (upper === 'G') return 'Gas';
  if (upper === 'D') return 'Dust';
  if (upper === 'GD' || upper === 'G/D') return 'Hybrid';
  if (['Gas', 'Dust', 'Hybrid', 'NonEx'].includes(raw)) return raw;
  return raw ? 'Hybrid' : 'NonEx';
}

function rbEnvironmentToMarking(value) {
  const raw = String(value || '').trim();
  if (raw === 'Gas') return 'G';
  if (raw === 'Dust') return 'D';
  if (raw === 'Hybrid') return 'GD';
  return raw;
}

function valuesFromEquipmentMarkings(markings = {}) {
  const marks = Array.isArray(markings) ? markings : [];
  const first = marks[0] || {};
  return {
    scheme: 'ATEX',
    certificateNo: '',
    compliance: '',
    environment: markingEnvironmentToRb(first.Environment || first['Environment']),
    protectionTypes: listValue(first['Type of Protection']),
    subGroup: listValue(first['Gas / Dust Group'] || first['Gas/Dust Group']),
    tempClass: first['Temperature Class'] || first['Temp Class'] || '',
    epl: listValue(first['Equipment Protection Level']),
    exMarking: marks
  };
}

function ensureRbAssignment(entity, rbSchema, values, userId = null) {
  if (!entity || !rbSchema?._id) return;
  const current = Array.isArray(entity.schemaAssignments) ? entity.schemaAssignments : [];
  const next = [...current];
  const idx = next.findIndex((a) => String(a?.schemaId) === String(rbSchema._id) || a?.schemaKey === 'rb');
  const assignment = {
    schemaId: rbSchema._id,
    schemaKey: 'rb',
    attachedAt: new Date(),
    attachedBy: userId || null,
    values: { ...(values || {}) }
  };
  if (idx >= 0) next[idx] = assignment;
  else next.push(assignment);
  entity.schemaAssignments = next;
}

function attachEquipmentMarkings(entity, rbSchema, markings, userId = null) {
  ensureRbAssignment(entity, rbSchema, valuesFromEquipmentMarkings(markings), userId);
  if (entity?.markModified) entity.markModified('schemaAssignments');
}

module.exports = {
  findRbAssignment,
  getRbValues,
  zoneView,
  equipmentMarkings,
  primaryEquipmentMarking,
  protectionText,
  certificateNo,
  complianceStatus,
  markingEnvironmentToRb,
  rbEnvironmentToMarking,
  valuesFromEquipmentMarkings,
  ensureRbAssignment,
  attachEquipmentMarkings
};
