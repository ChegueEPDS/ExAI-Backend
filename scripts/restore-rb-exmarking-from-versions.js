require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

require('../models/user');
require('../models/tenant');
require('../models/site');
const Equipment = require('../models/dataplate');
const EquipmentDataVersion = require('../models/equipmentDataVersion');
const { ensureRbSchema } = require('../services/schemaSeedService');
const { getRbValues, valuesFromEquipmentMarkings } = require('../services/rbSchemaValueService');

const APPLY = process.argv.includes('--apply');
const TENANT_ARG = process.argv.find((arg) => arg.startsWith('--tenant='));
const tenantId = TENANT_ARG ? TENANT_ARG.slice('--tenant='.length).trim() : '';

function tenantFilter() {
  if (!tenantId) return {};
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error(`Invalid --tenant ObjectId: ${tenantId}`);
  }
  return { tenantId: new mongoose.Types.ObjectId(tenantId) };
}

function rbAssignment(entity) {
  const assignments = Array.isArray(entity?.schemaAssignments) ? entity.schemaAssignments : [];
  return assignments.find((assignment) => assignment?.schemaKey === 'rb') || null;
}

function snapshotRbValues(snapshot) {
  return rbAssignment(snapshot)?.values || {};
}

function snapshotMarkings(snapshot) {
  const rbValues = snapshotRbValues(snapshot);
  if (Array.isArray(rbValues.exMarking) && rbValues.exMarking.length) return rbValues.exMarking;
  if (Array.isArray(snapshot?.['Ex Marking']) && snapshot['Ex Marking'].length) return snapshot['Ex Marking'];

  const flatMarking = {
    Marking: snapshot?.Marking || '',
    'Equipment Group': snapshot?.['Equipment Group'] || '',
    'Equipment Category': snapshot?.['Equipment Category'] || '',
    Environment: snapshot?.Environment || '',
    'Type of Protection': snapshot?.['Type of Protection'] || '',
    'Gas / Dust Group': snapshot?.['Gas / Dust Group'] || '',
    'Temperature Class': snapshot?.['Temperature Class'] || '',
    'Equipment Protection Level': snapshot?.['Equipment Protection Level'] || ''
  };
  return Object.values(flatMarking).some((value) => String(value || '').trim()) ? [flatMarking] : [];
}

function normalizeCompliance(value) {
  const v = String(value || 'NA').trim();
  return ['Passed', 'Failed', 'NA'].includes(v) ? v : 'NA';
}

async function latestVersionWithMarking(equipment) {
  return EquipmentDataVersion.findOne({
    tenantId: equipment.tenantId,
    equipmentId: equipment._id,
    $or: [
      { 'snapshot.Ex Marking.0': { $exists: true } },
      { 'snapshot.schemaAssignments': { $elemMatch: { schemaKey: 'rb', 'values.exMarking.0': { $exists: true } } } },
      { 'snapshot.Marking': { $exists: true, $nin: [null, ''] } }
    ]
  }).sort({ version: -1, changedAt: -1 }).lean();
}

async function main() {
  await connectDB();
  const rbSchema = await ensureRbSchema({ refreshQuestions: false });
  const filter = {
    ...tenantFilter(),
    'schemaAssignments.schemaKey': 'rb',
    schemaAssignments: {
      $not: {
        $elemMatch: {
          schemaKey: 'rb',
          'values.exMarking.0': { $exists: true }
        }
      }
    }
  };

  let checked = 0;
  let wouldRestore = 0;
  let restored = 0;
  let noVersionSource = 0;
  const examples = [];

  const cursor = Equipment.find(filter).cursor();
  for await (const equipment of cursor) {
    checked += 1;
    const version = await latestVersionWithMarking(equipment);
    const snapshot = version?.snapshot || null;
    const markings = snapshotMarkings(snapshot);
    if (!markings.length) {
      noVersionSource += 1;
      continue;
    }

    wouldRestore += 1;
    if (examples.length < 5) {
      examples.push({
        equipmentId: String(equipment._id),
        eqId: equipment.EqID || '',
        version: version.version,
        markings: markings.length
      });
    }

    if (!APPLY) continue;

    const currentValues = getRbValues(equipment);
    const versionValues = snapshotRbValues(snapshot);
    const markingValues = valuesFromEquipmentMarkings(markings);
    const nextValues = {
      ...currentValues,
      ...markingValues,
      exMarking: markings,
      certificateNo:
        String(currentValues.certificateNo || '').trim() ||
        String(versionValues.certificateNo || '').trim() ||
        String(snapshot?.['Certificate No'] || '').trim(),
      compliance: normalizeCompliance(
        currentValues.compliance && currentValues.compliance !== 'NA'
          ? currentValues.compliance
          : (versionValues.compliance || snapshot?.Compliance)
      )
    };

    const assignments = Array.isArray(equipment.schemaAssignments) ? [...equipment.schemaAssignments] : [];
    const idx = assignments.findIndex((assignment) => String(assignment?.schemaId) === String(rbSchema._id) || assignment?.schemaKey === 'rb');
    const nextAssignment = {
      ...(idx >= 0 ? assignments[idx] : {}),
      schemaId: rbSchema._id,
      schemaKey: 'rb',
      attachedAt: idx >= 0 ? assignments[idx].attachedAt : new Date(),
      attachedBy: idx >= 0 ? (assignments[idx].attachedBy ?? null) : null,
      values: nextValues
    };
    if (idx >= 0) assignments[idx] = nextAssignment;
    else assignments.push(nextAssignment);

    equipment.schemaAssignments = assignments;
    equipment.markModified('schemaAssignments');
    await equipment.save({ validateBeforeSave: false });
    restored += 1;
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    tenantId: tenantId || 'all',
    checked,
    wouldRestore,
    restored,
    noVersionSource,
    examples
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
