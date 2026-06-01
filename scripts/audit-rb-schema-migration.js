require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

require('../models/user');
require('../models/tenant');
require('../models/site');
const Site = require('../models/site');
const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');

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

function tenantFilter() {
  if (!tenantId) return {};
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error(`Invalid --tenant ObjectId: ${tenantId}`);
  }
  return { tenantId: new mongoose.Types.ObjectId(tenantId) };
}

function existsAny(fields) {
  return { $or: fields.map((field) => ({ [field]: { $exists: true } })) };
}

function equipmentNonEmptyLegacyFilter() {
  const fieldsWithoutExMarking = EQUIPMENT_LEGACY_FIELDS.filter((field) => field !== 'Ex Marking');
  return {
    $or: [
      { 'Ex Marking.0': { $exists: true } },
      ...fieldsWithoutExMarking.map((field) => ({ [field]: { $exists: true, $nin: [null, '', []] } }))
    ]
  };
}

async function main() {
  await connectDB();
  const base = tenantFilter();
  const [
    sitesTotal,
    sitesWithSchemas,
    zonesTotal,
    zonesWithRb,
    zonesMissingRb,
    zonesWithLegacy,
    equipmentTotal,
    equipmentWithRb,
    equipmentMissingRb,
    equipmentWithLegacy,
    equipmentLegacyWithoutRb,
    equipmentRbWithoutExMarking
  ] = await Promise.all([
    Site.countDocuments(base),
    Site.countDocuments({ ...base, schemaAssignments: { $exists: true, $ne: [] } }),
    Unit.countDocuments(base),
    Unit.countDocuments({ ...base, 'schemaAssignments.schemaKey': 'rb' }),
    Unit.countDocuments({ ...base, 'schemaAssignments.schemaKey': { $ne: 'rb' } }),
    Unit.countDocuments({ ...base, ...existsAny(ZONE_LEGACY_FIELDS) }),
    Equipment.countDocuments(base),
    Equipment.countDocuments({ ...base, 'schemaAssignments.schemaKey': 'rb' }),
    Equipment.countDocuments({ ...base, 'schemaAssignments.schemaKey': { $ne: 'rb' } }),
    Equipment.countDocuments({ ...base, ...equipmentNonEmptyLegacyFilter() }),
    Equipment.countDocuments({ ...base, 'schemaAssignments.schemaKey': { $ne: 'rb' }, ...equipmentNonEmptyLegacyFilter() }),
    Equipment.countDocuments({
      ...base,
      schemaAssignments: {
        $elemMatch: {
          schemaKey: 'rb',
          $or: [
            { 'values.exMarking': { $exists: false } },
            { 'values.exMarking': { $size: 0 } }
          ]
        }
      }
    })
  ]);

  const result = {
    tenantId: tenantId || 'all',
    sites: { total: sitesTotal, withAnySchema: sitesWithSchemas },
    zones: { total: zonesTotal, withRb: zonesWithRb, missingRb: zonesMissingRb, withLegacyFields: zonesWithLegacy },
    equipment: {
      total: equipmentTotal,
      withRb: equipmentWithRb,
      missingRb: equipmentMissingRb,
      withLegacyFields: equipmentWithLegacy,
      legacyFieldsWithoutRb: equipmentLegacyWithoutRb,
      rbWithoutExMarking: equipmentRbWithoutExMarking
    },
    prodReady: zonesWithLegacy === 0 && equipmentWithLegacy === 0 && equipmentLegacyWithoutRb === 0
  };

  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();

  if (!result.prodReady) process.exitCode = 2;
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
