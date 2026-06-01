require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

require('../models/user');
require('../models/tenant');
require('../models/site');
const Site = require('../models/site');
const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');
const FieldLayout = require('../models/fieldLayout');
const SchemaDefinition = require('../models/schemaDefinition');
require('../models/criteriaSystem');
require('../models/deviceCriteriaSystemAssignment');

const APPLY = process.argv.includes('--apply');
const DROP_CRITERIA = process.argv.includes('--drop-criteria');
const REMOVE_UNASSIGNED_RB_LEGACY = process.argv.includes('--remove-unassigned-rb-legacy');
const TENANT_ARG = process.argv.find((arg) => arg.startsWith('--tenant='));
const tenantId = TENANT_ARG ? TENANT_ARG.slice('--tenant='.length).trim() : '';

const ZONE_LEGACY_FIELDS = [
  'Scheme',
  'Environment',
  'Zone',
  'SubGroup',
  'TempClass',
  'MaxTemp',
  'IpRating',
  'EPL',
  'AmbientTempMin',
  'AmbientTempMax',
  'clientReq'
];

const EQUIPMENT_LEGACY_FIELDS = [
  'Certificate No',
  'Compliance',
  'Ex Marking',
  'Marking',
  'Equipment Group',
  'Equipment Category',
  'Environment',
  'Type of Protection',
  'Gas / Dust Group',
  'Temperature Class',
  'Equipment Protection Level'
];

const SITE_LEGACY_FIELDS = [
  'Scheme',
  'Environment',
  'Zone',
  'SubGroup',
  'TempClass',
  'MaxTemp',
  'IpRating',
  'EPL',
  'AmbientTempMin',
  'AmbientTempMax'
];

function tenantFilter() {
  if (!tenantId) return {};
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error(`Invalid --tenant ObjectId: ${tenantId}`);
  }
  return { tenantId: new mongoose.Types.ObjectId(tenantId) };
}

function existsAny(fields) {
  return {
    $or: fields.map((field) => ({ [field]: { $exists: true } }))
  };
}

function rbMigratedFilter(fields) {
  return {
    ...tenantFilter(),
    'schemaAssignments.schemaKey': 'rb',
    ...existsAny(fields)
  };
}

function rbMissingFilter(fields) {
  return {
    ...tenantFilter(),
    'schemaAssignments.schemaKey': { $ne: 'rb' },
    ...existsAny(fields)
  };
}

function unsetPayload(fields) {
  return Object.fromEntries(fields.map((field) => [field, '']));
}

async function cleanupCollection(label, Model, fields) {
  const migratedFilter = rbMigratedFilter(fields);
  const missingFilter = rbMissingFilter(fields);
  const [wouldClean, skippedNoRb] = await Promise.all([
    Model.countDocuments(migratedFilter),
    Model.countDocuments(missingFilter)
  ]);

  let modified = 0;
  if (APPLY && wouldClean > 0) {
    const result = await Model.updateMany(
      migratedFilter,
      { $unset: unsetPayload(fields) },
      { strict: false, runValidators: false }
    );
    modified = result.modifiedCount || result.nModified || 0;
  }

  return { label, wouldClean, modified, skippedNoRb };
}

async function cleanupEmptyEquipmentLegacyWithoutRb() {
  const filter = {
    ...tenantFilter(),
    'schemaAssignments.schemaKey': { $ne: 'rb' },
    'Ex Marking': { $exists: true, $size: 0 }
  };
  const wouldClean = await Equipment.countDocuments(filter);
  let modified = 0;
  if (APPLY && wouldClean > 0) {
    const result = await Equipment.updateMany(
      filter,
      { $unset: { 'Ex Marking': '' } },
      { strict: false, runValidators: false }
    );
    modified = result.modifiedCount || result.nModified || 0;
  }
  return { wouldClean, modified };
}

async function cleanupUnassignedRbLegacy(label, Model, fields) {
  const filter = rbMissingFilter(fields);
  const wouldClean = await Model.countDocuments(filter);
  let modified = 0;
  if (APPLY && REMOVE_UNASSIGNED_RB_LEGACY && wouldClean > 0) {
    const result = await Model.updateMany(
      filter,
      { $unset: unsetPayload(fields) },
      { strict: false, runValidators: false }
    );
    modified = result.modifiedCount || result.nModified || 0;
  }
  return {
    label,
    wouldClean,
    modified,
    mode: REMOVE_UNASSIGNED_RB_LEGACY ? 'remove' : 'kept'
  };
}

async function cleanupFieldLayouts() {
  const legacyByEntity = {
    site: SITE_LEGACY_FIELDS,
    zone: ZONE_LEGACY_FIELDS,
    equipment: EQUIPMENT_LEGACY_FIELDS
  };

  const output = {};
  for (const [entityType, fields] of Object.entries(legacyByEntity)) {
    const filter = {
      ...tenantFilter(),
      entityType,
      items: {
        $elemMatch: {
          source: 'system',
          fieldKey: { $in: fields }
        }
      }
    };
    const wouldClean = await FieldLayout.countDocuments(filter);
    let modified = 0;
    if (APPLY && wouldClean > 0) {
      const result = await FieldLayout.updateMany(
        filter,
        { $pull: { items: { source: 'system', fieldKey: { $in: fields } } } }
      );
      modified = result.modifiedCount || result.nModified || 0;
    }
    output[entityType] = { wouldClean, modified };
  }
  return output;
}

async function cleanupCriteriaCollections() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const names = new Set(collections.map((collection) => collection.name));
  const targets = ['criteriasystems', 'devicecriteriasystemassignments'];
  const output = {};
  const base = tenantFilter();
  const hasTenantScope = !!base.tenantId;

  for (const name of targets) {
    if (!names.has(name)) {
      output[name] = { exists: false, wouldDelete: 0, deleted: 0 };
      continue;
    }
    const collection = mongoose.connection.db.collection(name);
    const filter = hasTenantScope ? base : {};
    const wouldDelete = await collection.countDocuments(filter);
    let deleted = 0;
    if (APPLY && DROP_CRITERIA && wouldDelete > 0) {
      const result = await collection.deleteMany(filter);
      deleted = result.deletedCount || 0;
    }
    output[name] = {
      exists: true,
      wouldDelete,
      deleted,
      mode: DROP_CRITERIA ? 'delete' : 'kept'
    };
  }
  return output;
}

async function cleanupOrphanSchemaAssignmentsInCollection(label, Model, schemaIds) {
  const baseFilter = tenantFilter();
  const filter = {
    ...baseFilter,
    schemaAssignments: {
      $elemMatch: {
        schemaKey: { $ne: 'rb' },
        schemaId: { $nin: schemaIds }
      }
    }
  };
  const wouldClean = await Model.countDocuments(filter);
  let modified = 0;
  if (APPLY && wouldClean > 0) {
    const result = await Model.updateMany(
      filter,
      { $pull: { schemaAssignments: { schemaKey: { $ne: 'rb' }, schemaId: { $nin: schemaIds } } } },
      { runValidators: false }
    );
    modified = result.modifiedCount || result.nModified || 0;
  }
  return { label, wouldClean, modified };
}

async function cleanupOrphanSchemaAssignments() {
  const schemas = await SchemaDefinition.find(tenantId ? {
    $or: [{ scope: 'system' }, { tenantId: new mongoose.Types.ObjectId(tenantId) }]
  } : {}).select('_id').lean();
  const schemaIds = schemas.map((schema) => schema._id);
  return {
    sites: await cleanupOrphanSchemaAssignmentsInCollection('sites', Site, schemaIds),
    zones: await cleanupOrphanSchemaAssignmentsInCollection('zones', Unit, schemaIds),
    equipment: await cleanupOrphanSchemaAssignmentsInCollection('equipment', Equipment, schemaIds)
  };
}

async function main() {
  await connectDB();

  const [
    sites,
    zones,
    equipment,
    unassignedRbLegacy,
    emptyEquipmentLegacyWithoutRb,
    fieldLayouts,
    orphanSchemaAssignments,
    criteriaCollections
  ] = await Promise.all([
    cleanupCollection('sites', Site, SITE_LEGACY_FIELDS),
    cleanupCollection('zones', Unit, ZONE_LEGACY_FIELDS),
    cleanupCollection('equipment', Equipment, EQUIPMENT_LEGACY_FIELDS),
    Promise.all([
      cleanupUnassignedRbLegacy('sites', Site, SITE_LEGACY_FIELDS),
      cleanupUnassignedRbLegacy('zones', Unit, ZONE_LEGACY_FIELDS),
      cleanupUnassignedRbLegacy('equipment', Equipment, EQUIPMENT_LEGACY_FIELDS)
    ]),
    cleanupEmptyEquipmentLegacyWithoutRb(),
    cleanupFieldLayouts(),
    cleanupOrphanSchemaAssignments(),
    cleanupCriteriaCollections()
  ]);

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    tenantId: tenantId || 'all',
    collections: { sites, zones, equipment },
    unassignedRbLegacy: {
      sites: unassignedRbLegacy[0],
      zones: unassignedRbLegacy[1],
      equipment: unassignedRbLegacy[2]
    },
    emptyEquipmentLegacyWithoutRb,
    fieldLayouts,
    orphanSchemaAssignments,
    criteriaCollections,
    note: APPLY
      ? 'Legacy RB fields removed only from documents that already have schemaAssignments.schemaKey=rb. Use --drop-criteria with --apply to delete old criteria collections.'
      : 'Dry-run only. Re-run with --apply to remove legacy RB fields. Add --remove-unassigned-rb-legacy to also remove legacy RB fields from entities without RB assignment; add --drop-criteria to delete old criteria collections.'
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
