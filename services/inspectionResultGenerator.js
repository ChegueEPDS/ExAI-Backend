const mongoose = require('mongoose');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const SchemaExtension = require('../models/schemaExtension');
const { buildCertificateCacheForTenant, resolveCertificateFromCache } = require('../helpers/certificateMatchHelper');
const { KNOWN_SET_LOWER, normalizeProtectionMethodTypes } = require('../helpers/protectionTypes');
const { certificateNo, protectionText } = require('./rbSchemaValueService');
const { ensureRbSchema, loadLegacyRbQuestions } = require('./schemaSeedService');

function deriveQuestionReference(input = {}) {
  const explicit = String(input.reference || '').trim();
  if (explicit) return explicit;
  const table = String(input.table || input.Table || '').trim();
  const number = input.number ?? input.Number;
  if (table === 'SC' || input.equipmentType === 'Special Condition') return `SC${number || 1}`;
  if (table && (number || number === 0)) return `${table}-${number}`;
  if (number || number === 0) return `${number}`;
  return '';
}

function extractProtectionTokens(equipmentDoc) {
  const protection = protectionText(equipmentDoc) || '';
  if (!protection) return [];
  const tokens = normalizeProtectionMethodTypes(protection).map((value) => String(value).trim().toLowerCase());
  const hasKnown = tokens.some((token) => KNOWN_SET_LOWER.has(token));
  if (!hasKnown && tokens.length) return Array.from(new Set(['d', 'e', ...tokens]));
  return tokens;
}

async function computeRelevantEquipmentTypes(equipmentDoc, tenantId) {
  const rawType = equipmentDoc?.['Equipment Type'] || equipmentDoc?.EquipmentType || '';
  const normalized = String(rawType).toLowerCase().trim();
  const result = new Set();
  if (!normalized || !tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) return result;

  const mappings = await QuestionTypeMapping.find({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    active: true
  }).select('equipmentPattern equipmentTypes').lean();

  for (const mapping of mappings || []) {
    const pattern = String(mapping.equipmentPattern || '').toLowerCase().trim();
    if (!pattern || !normalized.includes(pattern)) continue;
    for (const type of mapping.equipmentTypes || []) {
      if (type) result.add(String(type).toLowerCase());
    }
  }
  return result;
}

async function buildSpecialConditionResult(equipmentDoc, tenantId) {
  const equipmentSpecific = typeof equipmentDoc?.['X condition']?.Specific === 'string'
    ? equipmentDoc['X condition'].Specific.trim()
    : '';
  let text = equipmentSpecific;
  if (!text) {
    const certNo = certificateNo(equipmentDoc);
    if (certNo) {
      const certMap = await buildCertificateCacheForTenant(tenantId);
      text = (resolveCertificateFromCache(certMap, String(certNo))?.specCondition || '').trim();
    }
  }
  if (!text) return null;

  return {
    questionId: undefined,
    reference: 'SC1',
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
  const rbSchema = await ensureRbSchema();
  const [baseQuestions, extension] = await Promise.all([
    loadLegacyRbQuestions(),
    SchemaExtension.findOne({ tenantId, schemaId: rbSchema._id }).lean()
  ]);
  const tenantQuestions = (extension?.extraQuestions || [])
    .filter((question) => question?.active !== false)
    .map((question) => ({
      ...question,
      equipmentType: question.equipmentType || question.group || 'General',
      protectionTypes: Array.isArray(question.protectionTypes) ? question.protectionTypes : [],
      inspectionTypes: Array.isArray(question.inspectionTypes) ? question.inspectionTypes : [],
      origin: 'tenant'
    }));
  const questions = [...baseQuestions.map((question) => ({ ...question, origin: 'system' })), ...tenantQuestions]
    .map((question) => (question?.toObject ? question.toObject() : question))
    .filter((question) => {
      const questionProtections = Array.isArray(question.protectionTypes)
        ? question.protectionTypes.map((type) => String(type || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!protections.length || !questionProtections.length) return true;
      return questionProtections.some((type) => protections.includes(type));
    });

  const relevantTypes = await computeRelevantEquipmentTypes(equipmentDoc, tenantId);
  const basePassedTypes = new Set(['general', 'environment', 'additional checks', 'installation']);
  const results = questions
    .filter((question) => {
      const types = Array.isArray(question.inspectionTypes) ? question.inspectionTypes : [];
      return !types.length || types.includes(inspectionType);
    })
    .map((question) => {
      const equipmentType = String(question.equipmentType || '').toLowerCase();
      const passed = basePassedTypes.has(equipmentType) ||
        equipmentType.startsWith('installation') || relevantTypes.has(equipmentType);
      return {
        questionId: undefined,
        schemaQuestionKey: question.key || undefined,
        questionOrigin: question.origin || 'system',
        reference: deriveQuestionReference(question),
        table: question.table || question.Table || '',
        group: question.group || question.Group || '',
        number: question.number ?? question.Number ?? null,
        equipmentType: question.equipmentType || '',
        protectionTypes: Array.isArray(question.protectionTypes) ? question.protectionTypes : [],
        status: passed ? 'Passed' : 'NA',
        note: '',
        questionText: {
          eng: question.textI18n?.eng || question.questionText?.eng || question.text || '',
          hun: question.textI18n?.hun || question.questionText?.hun || ''
        }
      };
    });

  const specialCondition = await buildSpecialConditionResult(equipmentDoc, tenantId);
  if (specialCondition) results.push(specialCondition);
  return results;
}

module.exports = { generateInspectionResultsForEquipment };
