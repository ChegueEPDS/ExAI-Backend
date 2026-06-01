require('dotenv').config();
const connectDB = require('../config/db');
require('../models/user');
require('../models/tenant');

const CriteriaSystem = require('../models/criteriaSystem');
const DeviceAssignment = require('../models/deviceCriteriaSystemAssignment');
const Equipment = require('../models/dataplate');
const SchemaDefinition = require('../models/schemaDefinition');
const { normalizeKey } = require('../services/schemaValidationService');

const archiveOld = process.argv.includes('--archive-old');
const includeInherited = !process.argv.includes('--explicit-only');

function schemaFieldsFromCriteria(criteria) {
  const seen = new Set(['cycleValue', 'cycleUnit', 'startDate']);
  const custom = (criteria.customFields || [])
    .filter((field) => field && field.active !== false)
    .map((field, idx) => {
      let key = normalizeKey(field.key || field.label);
      if (!key || seen.has(key)) key = `field_${idx + 1}`;
      seen.add(key);
      return {
        key,
        label: field.label || field.key || key,
        fieldType: field.fieldType || 'text',
        options: Array.isArray(field.options) ? field.options : [],
        required: !!field.required,
        active: field.active !== false,
        order: idx + 1
      };
    });
  return custom;
}

function schemaQuestionsFromCriteria(criteria) {
  return (criteria.questions || [])
    .filter((question) => question && question.active !== false)
    .map((question, idx) => ({
      key: normalizeKey(question.key || question.text || `q_${idx + 1}`) || `q_${idx + 1}`,
      text: question.text,
      textI18n: { eng: question.text || '', hun: '' },
      group: 'General',
      order: Number.isFinite(Number(question.order)) ? Number(question.order) : idx + 1,
      active: question.active !== false,
      origin: 'tenant'
    }));
}

async function upsertSchema(criteria) {
  const payload = {
    scope: 'tenant',
    tenantId: criteria.tenantId,
    systemKey: null,
    name: criteria.name,
    type: criteria.type,
    description: `Migrated from criteria system ${criteria._id}.`,
    status: 'published',
    systemProvided: false,
    targetLevels: ['equipment'],
    ruleset: null,
    defaultCycleValue: criteria.cycle?.value || 1,
    defaultCycleUnit: criteria.cycle?.unit || 'year',
    dataFields: schemaFieldsFromCriteria(criteria),
    questions: criteria.type === 'compliance' ? schemaQuestionsFromCriteria(criteria) : [],
    active: criteria.active !== false,
    createdBy: criteria.createdBy || null,
    updatedBy: criteria.updatedBy || criteria.createdBy || null
  };

  const existing = await SchemaDefinition.findOne({ scope: 'tenant', tenantId: criteria.tenantId, name: criteria.name });
  if (existing) {
    existing.type = payload.type;
    existing.description = payload.description;
    existing.status = 'published';
    existing.targetLevels = payload.targetLevels;
    existing.defaultCycleValue = payload.defaultCycleValue;
    existing.defaultCycleUnit = payload.defaultCycleUnit;
    existing.dataFields = payload.dataFields;
    existing.questions = payload.questions;
    existing.active = payload.active;
    existing.updatedBy = payload.updatedBy;
    await existing.save();
    return existing;
  }

  return SchemaDefinition.create(payload);
}

function assignmentValues(criteria, assignment, equipment) {
  const cycle = assignment?.cycleOverride || criteria.cycle || {};
  const values = {
    cycleValue: cycle.value || criteria.cycle?.value || 1,
    cycleUnit: cycle.unit || criteria.cycle?.unit || 'year'
  };

  const customFields = equipment?.customFields instanceof Map
    ? Object.fromEntries(equipment.customFields.entries())
    : (equipment?.customFields || {});
  for (const field of criteria.customFields || []) {
    const key = normalizeKey(field.key || field.label);
    const originalKey = String(field.key || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(customFields, key)) {
      values[key] = customFields[key];
    } else if (key && originalKey && Object.prototype.hasOwnProperty.call(customFields, originalKey)) {
      values[key] = customFields[originalKey];
    }
  }
  return values;
}

async function attachSchema(equipment, schema, values, userId = null) {
  const current = Array.isArray(equipment.schemaAssignments) ? [...equipment.schemaAssignments] : [];
  const idx = current.findIndex((assignment) => String(assignment.schemaId) === String(schema._id));
  const payload = {
    schemaId: schema._id,
    schemaKey: null,
    attachedAt: new Date(),
    attachedBy: userId,
    values
  };
  if (idx >= 0) current[idx] = payload;
  else current.push(payload);
  await Equipment.updateOne(
    { _id: equipment._id },
    { $set: { schemaAssignments: current } },
    { runValidators: false }
  );
}

async function migrateAssignments(criteria, schema) {
  let attached = 0;
  const explicit = await DeviceAssignment.find({
    tenantId: criteria.tenantId,
    criteriaSystemId: criteria._id,
    active: { $ne: false },
    state: 'included'
  }).lean();

  const handled = new Set();
  for (const assignment of explicit) {
    const equipment = await Equipment.findOne({ _id: assignment.equipmentId, tenantId: criteria.tenantId }).lean();
    if (!equipment) continue;
    await attachSchema(equipment, schema, assignmentValues(criteria, assignment, equipment), assignment.updatedBy || null);
    handled.add(String(equipment._id));
    attached += 1;
  }

  if (includeInherited && criteria.active !== false && criteria.assignmentScope === 'general') {
    const excluded = await DeviceAssignment.find({
      tenantId: criteria.tenantId,
      criteriaSystemId: criteria._id,
      active: { $ne: false },
      state: 'excluded'
    }).select('equipmentId').lean();
    const excludedIds = new Set(excluded.map((item) => String(item.equipmentId)));
    const cursor = Equipment.find({ tenantId: criteria.tenantId }).lean().cursor();
    for await (const equipment of cursor) {
      const id = String(equipment._id);
      if (handled.has(id) || excludedIds.has(id)) continue;
      await attachSchema(equipment, schema, assignmentValues(criteria, null, equipment), criteria.updatedBy || null);
      attached += 1;
    }
  }

  return attached;
}

async function main() {
  await connectDB();
  const criteriaSystems = await CriteriaSystem.find({
    systemKey: { $ne: 'explosion_safety' }
  }).lean();
  const stats = { schemas: 0, assignments: 0, archivedOld: 0 };

  for (const criteria of criteriaSystems) {
    const schema = await upsertSchema(criteria);
    stats.schemas += 1;
    stats.assignments += await migrateAssignments(criteria, schema);
    if (archiveOld) {
      await CriteriaSystem.updateOne({ _id: criteria._id }, { $set: { active: false } });
      stats.archivedOld += 1;
    }
  }

  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await require('mongoose').disconnect();
  });
