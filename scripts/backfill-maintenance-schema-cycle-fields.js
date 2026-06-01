require('dotenv').config();
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const SchemaDefinition = require('../models/schemaDefinition');
const Site = require('../models/site');
const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');
const {
  applySchemaCycleDefaults,
  normalizeCycleUnit,
  normalizeCycleValue,
  stripCycleDataFields
} = require('../services/schemaCycleService');

const apply = process.argv.includes('--apply');

async function main() {
  await connectDB();

  const schemas = await SchemaDefinition.find({});
  const schemaById = new Map(schemas.map((schema) => [String(schema._id), schema]));
  const changed = [];

  for (const schema of schemas) {
    const fields = Array.isArray(schema.dataFields) ? schema.dataFields : [];
    const removedCycleFields = fields
      .filter((field) => ['cycleValue', 'cycleUnit', 'startDate'].includes(field?.key))
      .map((field) => field.key);
    const nextFields = stripCycleDataFields(fields);

    let defaultCycleValue = normalizeCycleValue(schema.defaultCycleValue, 1);
    let defaultCycleUnit = normalizeCycleUnit(schema.defaultCycleUnit, 'year');
    if (schema.systemKey === 'rb') {
      defaultCycleValue = 3;
      defaultCycleUnit = 'year';
    } else if (!schema.defaultCycleValue || !schema.defaultCycleUnit) {
      const cycleValueField = fields.find((field) => field?.key === 'cycleValue');
      const cycleUnitField = fields.find((field) => field?.key === 'cycleUnit');
      defaultCycleValue = normalizeCycleValue(cycleValueField?.defaultValue, defaultCycleValue);
      defaultCycleUnit = normalizeCycleUnit(cycleUnitField?.defaultValue, defaultCycleUnit);
    }

    const willChange = removedCycleFields.length ||
      schema.defaultCycleValue !== defaultCycleValue ||
      schema.defaultCycleUnit !== defaultCycleUnit;
    if (!willChange) continue;

    changed.push({
      schemaId: schema._id,
      name: schema.name,
      tenantId: schema.tenantId,
      removedDataFields: removedCycleFields,
      defaultCycleValue,
      defaultCycleUnit
    });

    if (apply) {
      await SchemaDefinition.updateOne(
        { _id: schema._id },
        {
          $set: {
            dataFields: nextFields,
            defaultCycleValue,
            defaultCycleUnit
          }
        }
      );
      schema.dataFields = nextFields;
      schema.defaultCycleValue = defaultCycleValue;
      schema.defaultCycleUnit = defaultCycleUnit;
    }
  }

  async function backfillAssignments(label, Model) {
    let checked = 0;
    let wouldUpdate = 0;
    const docs = await Model.find({ schemaAssignments: { $exists: true, $ne: [] } }).lean();
    for (const doc of docs) {
      checked += 1;
      let touched = false;
      const next = (doc.schemaAssignments || []).map((assignment) => {
        const schema = schemaById.get(String(assignment?.schemaId || ''));
        if (!schema) return assignment;
        const currentValues = assignment.values || {};
        const nextValues = applySchemaCycleDefaults(schema, currentValues);
        if (JSON.stringify(currentValues) !== JSON.stringify(nextValues)) touched = true;
        return { ...assignment, values: nextValues };
      });
      if (!touched) continue;
      wouldUpdate += 1;
      if (apply) {
        await Model.updateOne(
          { _id: doc._id },
          { $set: { schemaAssignments: next } }
        );
      }
    }
    return { label, checked, wouldUpdate, updated: apply ? wouldUpdate : 0 };
  }

  const assignmentBackfill = [
    await backfillAssignments('sites', Site),
    await backfillAssignments('zones', Unit),
    await backfillAssignments('equipment', Equipment)
  ];

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    checked: schemas.length,
    wouldUpdate: changed.length,
    updated: apply ? changed.length : 0,
    changed,
    assignmentBackfill
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
