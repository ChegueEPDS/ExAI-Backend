const SchemaDefinition = require('../models/schemaDefinition');
const Question = require('../models/questions');
const { sanitizeQuestions } = require('./schemaValidationService');

const RB_DATA_FIELDS = [
  { key: 'scheme', label: 'Scheme', fieldType: 'select', options: ['ATEX', 'IECEx', 'NA'], required: true, order: 1 },
  { key: 'certificateNo', label: 'Certificate No', fieldType: 'text', order: 2 },
  { key: 'compliance', label: 'Compliance', fieldType: 'select', options: ['Passed', 'Failed', 'NA'], order: 3 },
  { key: 'environment', label: 'Environment', fieldType: 'select', options: ['Gas', 'Dust', 'Hybrid', 'NonEx'], required: true, order: 4 },
  { key: 'zone', label: 'Zone', fieldType: 'multiselect', options: ['0', '1', '2', '20', '21', '22'], order: 5 },
  { key: 'subGroup', label: 'Sub-Group', fieldType: 'multiselect', options: ['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC'], order: 6 },
  { key: 'tempClass', label: 'Temperature Class', fieldType: 'select', options: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], order: 7 },
  { key: 'maxTemp', label: 'Max Temperature', fieldType: 'number', order: 8 },
  { key: 'epl', label: 'EPL', fieldType: 'multiselect', options: ['Ga', 'Gb', 'Gc', 'Da', 'Db', 'Dc'], order: 9 },
  { key: 'ambientTempMin', label: 'Ambient Temp. min', fieldType: 'number', order: 10 },
  { key: 'ambientTempMax', label: 'Ambient Temp. max', fieldType: 'number', order: 11 },
  { key: 'clientRequirements', label: 'Client Requirements', fieldType: 'textarea', order: 12 }
];

async function loadLegacyRbQuestions() {
  const docs = await Question.find({})
    .sort({ table: 1, group: 1, number: 1, equipmentType: 1, createdAt: 1 })
    .lean();
  return sanitizeQuestions(docs.map((q, idx) => ({
    key: q._id ? `legacy_${q._id}` : undefined,
    text: q.questionText?.eng || '',
    textI18n: q.questionText || {},
    group: q.equipmentType || q.group || 'General',
    table: q.table || '',
    number: q.number ?? idx + 1,
    equipmentType: q.equipmentType || q.group || 'General',
    protectionTypes: Array.isArray(q.protectionTypes) ? q.protectionTypes : [],
    inspectionTypes: Array.isArray(q.inspectionTypes) ? q.inspectionTypes : [],
    order: idx + 1,
    active: true
  })), 'system');
}

function rbQuestionsNeedLegacyMetadata(questions = []) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return true;
  const hasProtectionMetadata = list.some((q) => Array.isArray(q?.protectionTypes) && q.protectionTypes.length);
  const hasInspectionMetadata = list.some((q) => Array.isArray(q?.inspectionTypes) && q.inspectionTypes.length);
  if (!hasProtectionMetadata || !hasInspectionMetadata) return true;
  return list.some((q) => {
    if (!q) return false;
    return (
      !Array.isArray(q.protectionTypes) ||
      !Array.isArray(q.inspectionTypes) ||
      typeof q.equipmentType !== 'string'
    );
  });
}

async function ensureRbSchema({ refreshQuestions = false, userId = null } = {}) {
  let rb = await SchemaDefinition.findOne({ scope: 'system', systemKey: 'rb' });
  if (!rb) {
    rb = new SchemaDefinition({
      scope: 'system',
      tenantId: null,
      systemKey: 'rb',
      name: 'Explosion Safety / RB',
      type: 'compliance',
      description: 'System-provided explosion safety / risk based compliance schema.',
      status: 'published',
      systemProvided: true,
      targetLevels: ['site', 'zone', 'equipment'],
      ruleset: 'rb_v1',
      defaultCycleValue: 3,
      defaultCycleUnit: 'year',
      dataFields: RB_DATA_FIELDS,
      questions: await loadLegacyRbQuestions(),
      active: true,
      createdBy: userId || null,
      updatedBy: userId || null
    });
    await rb.save();
    return rb;
  }

  let changed = false;
  if (rb.status !== 'published') {
    rb.status = 'published';
    changed = true;
  }
  if (rb.ruleset !== 'rb_v1') {
    rb.ruleset = 'rb_v1';
    changed = true;
  }
  if (rb.active === false) {
    rb.active = true;
    changed = true;
  }
  if (rb.defaultCycleValue !== 3 || rb.defaultCycleUnit !== 'year') {
    rb.defaultCycleValue = 3;
    rb.defaultCycleUnit = 'year';
    changed = true;
  }
  const existingKeys = new Set((rb.dataFields || []).map((field) => field?.key).filter(Boolean));
  const missingFields = RB_DATA_FIELDS.filter((field) => !existingKeys.has(field.key));
  if (!Array.isArray(rb.dataFields) || !rb.dataFields.length) {
    rb.dataFields = RB_DATA_FIELDS;
    changed = true;
  } else if (missingFields.length) {
    rb.dataFields = [...rb.dataFields, ...missingFields].sort((a, b) => (a.order || 0) - (b.order || 0));
    changed = true;
  }
  if (
    refreshQuestions ||
    !Array.isArray(rb.questions) ||
    !rb.questions.length ||
    rbQuestionsNeedLegacyMetadata(rb.questions)
  ) {
    rb.questions = await loadLegacyRbQuestions();
    changed = true;
  }
  if (changed) {
    rb.updatedBy = userId || rb.updatedBy || null;
    await rb.save();
  }
  return rb;
}

module.exports = {
  RB_DATA_FIELDS,
  ensureRbSchema,
  loadLegacyRbQuestions
};
