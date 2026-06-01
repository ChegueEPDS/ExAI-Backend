require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models/user');
require('../models/tenant');
require('../models/site');
const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const { ensureRbSchema } = require('../services/schemaSeedService');
const { normalizeRbValues } = require('../services/schemaRules/rbRules');

function upsertAssignment(doc, rbSchema, values) {
  const next = Array.isArray(doc.schemaAssignments) ? [...doc.schemaAssignments] : [];
  const idx = next.findIndex((a) => String(a.schemaId) === String(rbSchema._id) || a.schemaKey === 'rb');
  const existing = idx >= 0 && next[idx]?.values && typeof next[idx].values === 'object'
    ? next[idx].values
    : {};
  const assignment = {
    ...(idx >= 0 ? next[idx] : {}),
    schemaId: rbSchema._id,
    schemaKey: 'rb',
    attachedAt: idx >= 0 ? (next[idx].attachedAt || new Date()) : new Date(),
    attachedBy: idx >= 0 ? (next[idx].attachedBy ?? null) : null,
    values: { ...existing, ...values }
  };
  if (idx >= 0) next[idx] = assignment;
  else next.push(assignment);
  doc.schemaAssignments = next;
}

async function migrateUnits(rbSchema) {
  let updated = 0;
  const cursor = Unit.find({}).lean().cursor();
  for await (const unit of cursor) {
    if (!unit.Environment) continue;
    const values = normalizeRbValues({
      scheme: unit.Scheme || 'ATEX',
      environment: unit.Environment,
      zone: unit.Zone || [],
      subGroup: unit.SubGroup || [],
      tempClass: unit.TempClass || undefined,
      maxTemp: unit.MaxTemp ?? null,
      epl: unit.EPL || [],
      ambientTempMin: unit.AmbientTempMin ?? null,
      ambientTempMax: unit.AmbientTempMax ?? null,
      clientRequirements: unit.clientReq || []
    });
    upsertAssignment(unit, rbSchema, values);
    await Unit.updateOne(
      { _id: unit._id },
      { $set: { schemaAssignments: unit.schemaAssignments || [] } },
      { runValidators: false }
    );
    updated += 1;
  }
  return updated;
}

function markingToRbValues(marking = {}) {
  const envRaw = String(marking.Environment || '').trim().toUpperCase();
  const environment =
    envRaw === 'G' || envRaw === 'GAS' ? 'Gas' :
    envRaw === 'D' || envRaw === 'DUST' ? 'Dust' :
    envRaw === 'GD' || envRaw === 'HYBRID' ? 'Hybrid' :
    'NonEx';
  return normalizeRbValues({
    scheme: 'ATEX',
    environment,
    subGroup: marking['Gas / Dust Group'] ? [marking['Gas / Dust Group']] : [],
    tempClass: marking['Temperature Class'] || undefined,
    epl: marking['Equipment Protection Level'] ? [marking['Equipment Protection Level']] : []
  });
}

function normalizeCompliance(value) {
  const v = String(value || 'NA').trim();
  return ['Passed', 'Failed', 'NA'].includes(v) ? v : 'NA';
}

async function migrateEquipment(rbSchema) {
  let updated = 0;
  const cursor = Equipment.find({}).lean().cursor();
  for await (const equipment of cursor) {
    const marks = Array.isArray(equipment['Ex Marking']) ? equipment['Ex Marking'] : [];
    const certificateNo = String(equipment['Certificate No'] || '').trim();
    const rawCompliance = String(equipment.Compliance || '').trim();
    const hasMeaningfulCompliance = rawCompliance && rawCompliance !== 'NA';
    if (!marks.length && !certificateNo && !hasMeaningfulCompliance) continue;

    const existingAssignment = Array.isArray(equipment.schemaAssignments)
      ? equipment.schemaAssignments.find((a) => String(a.schemaId) === String(rbSchema._id) || a.schemaKey === 'rb')
      : null;
    const existingValues = existingAssignment?.values && typeof existingAssignment.values === 'object'
      ? existingAssignment.values
      : {};
    const values = marks.length
      ? markingToRbValues(marks[0] || {})
      : (Object.keys(existingValues).length ? { ...existingValues } : normalizeRbValues({ environment: 'NonEx' }));
    if (certificateNo) values.certificateNo = certificateNo;
    if (hasMeaningfulCompliance || !values.compliance) values.compliance = normalizeCompliance(rawCompliance);
    if (marks.length) values.exMarking = marks;
    upsertAssignment(equipment, rbSchema, values);
    await Equipment.updateOne(
      { _id: equipment._id },
      { $set: { schemaAssignments: equipment.schemaAssignments || [] } },
      { runValidators: false }
    );
    updated += 1;
  }
  return updated;
}

async function migrateInspections(rbSchema) {
  const result = await Inspection.updateMany(
    {
      schemaId: { $in: [null, undefined] },
      inspectionType: { $in: ['Detailed', 'Initial Detailed', 'Initial Detailed (Index)', 'Close', 'Visual'] }
    },
    {
      $set: {
        schemaId: rbSchema._id,
        schemaKeySnapshot: 'rb',
        schemaNameSnapshot: rbSchema.name,
        schemaTypeSnapshot: rbSchema.type
      }
    }
  );
  return result.modifiedCount || result.nModified || 0;
}

async function main() {
  await connectDB();
  const rbSchema = await ensureRbSchema({ refreshQuestions: true });
  const [units, equipment, inspections] = await Promise.all([
    migrateUnits(rbSchema),
    migrateEquipment(rbSchema),
    migrateInspections(rbSchema)
  ]);
  console.log(JSON.stringify({ rbSchemaId: String(rbSchema._id), units, equipment, inspections }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
