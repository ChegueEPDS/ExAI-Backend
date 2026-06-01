require('dotenv').config();

const mongoose = require('mongoose');

const connectDB = require('../config/db');
require('../models/user');
require('../models/tenant');
require('../models/site');
const Equipment = require('../models/dataplate');
const MaintenanceEvent = require('../models/maintenanceEvent');
const EquipmentDataVersion = require('../models/equipmentDataVersion');
const { ensureRbSchema } = require('../services/schemaSeedService');
const { complianceStatus, ensureRbAssignment, getRbValues } = require('../services/rbSchemaValueService');
const { ensureAutoInspectionFromMobileSync } = require('../services/mobileSyncWorker');

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function objectIdOrNull(value) {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function latestFaultDocument(equipment) {
  const docs = [
    ...(Array.isArray(equipment.documents) ? equipment.documents : []),
    ...(Array.isArray(equipment.Pictures) ? equipment.Pictures : [])
  ].filter((doc) => String(doc?.tag || '').toLowerCase() === 'fault');

  docs.sort((a, b) => {
    const ta = a?.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const tb = b?.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return tb - ta;
  });
  return docs[0] || null;
}

function hasFailedSignal(equipment) {
  return complianceStatus(equipment) === 'Failed' || !!latestFaultDocument(equipment);
}

function isMobileFaultOnlyVersionChange(changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  if (!paths.length) return false;
  return paths.every((path) =>
    /^schemaAssignments\.\d+\.attachedAt$/.test(path) ||
    /^schemaAssignments\.\d+\.attachedBy$/.test(path) ||
    /^schemaAssignments\.\d+\.values\.compliance$/.test(path)
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantArg = argValue('--tenantId');
  const tenantId = objectIdOrNull(tenantArg);
  const eqIdArg = argValue('--eqId').trim();

  await connectDB();

  const filter = {
    ...(tenantId ? { tenantId } : {}),
    ...(eqIdArg ? { EqID: eqIdArg } : {}),
    $or: [
      { schemaAssignments: { $elemMatch: { schemaKey: 'rb', 'values.compliance': 'Failed' } } },
      { 'documents.tag': 'fault' },
      { 'Pictures.tag': 'fault' }
    ]
  };

  const equipment = await Equipment.find(filter).sort({ updatedAt: -1 });
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    tenantId: tenantId ? String(tenantId) : 'all',
    checked: equipment.length,
    wouldRemoveMobileMaintenanceEvents: 0,
    removedMobileMaintenanceEvents: 0,
    wouldResetOperationalStatus: 0,
    resetOperationalStatus: 0,
    wouldSetRbFailed: 0,
    setRbFailed: 0,
    wouldCreatePendingInspections: 0,
    createdPendingInspections: 0,
    wouldRemoveHistoryNoise: 0,
    removedHistoryNoise: 0,
    skippedNoFailureSignal: 0,
    examples: []
  };

  for (const eq of equipment) {
    if (!hasFailedSignal(eq)) {
      report.skippedNoFailureSignal += 1;
      continue;
    }

    const mobileMaintenanceEvents = await MaintenanceEvent.find({
      tenantId: eq.tenantId,
      equipmentId: eq._id,
      kind: 'fault_reported',
      source: { $in: ['mobileSync', 'mobileSyncBackfill'] }
    }).select('_id').lean();
    const nonMobileMaintenanceEvent = await MaintenanceEvent.findOne({
      tenantId: eq.tenantId,
      equipmentId: eq._id,
      kind: { $in: ['fault_reported', 'repair_started', 'repair_completed'] },
      $or: [{ source: { $nin: ['mobileSync', 'mobileSyncBackfill'] } }, { source: null }, { source: { $exists: false } }]
    }).select('_id').lean();
    const noisyVersions = await EquipmentDataVersion.find({
      tenantId: eq.tenantId,
      equipmentId: eq._id,
      source: 'import'
    }).select('_id changedPaths').lean();
    const noisyVersionIds = noisyVersions
      .filter((version) => isMobileFaultOnlyVersionChange(version.changedPaths))
      .map((version) => version._id);

    const actorId = eq.ModifiedBy || eq.CreatedBy;
    const faultDoc = latestFaultDocument(eq);
    const shouldResetOperationalStatus = mobileMaintenanceEvents.length > 0 && !nonMobileMaintenanceEvent && eq.operationalStatus === 'failed';
    const needsRbFailed = complianceStatus(eq) !== 'Failed';
    const needsPendingInspection = !eq.pendingInspectionId;

    report.wouldRemoveMobileMaintenanceEvents += mobileMaintenanceEvents.length;
    if (shouldResetOperationalStatus) report.wouldResetOperationalStatus += 1;
    if (needsRbFailed) report.wouldSetRbFailed += 1;
    if (needsPendingInspection) {
      report.wouldCreatePendingInspections += 1;
    }
    report.wouldRemoveHistoryNoise += noisyVersionIds.length;

    if (report.examples.length < 10) {
      report.examples.push({
        equipmentId: String(eq._id),
        eqId: eq.EqID || '',
        rbCompliance: complianceStatus(eq),
        hasFaultPhoto: !!faultDoc,
        mobileMaintenanceEvents: mobileMaintenanceEvents.length,
        hasNonMobileMaintenanceEvent: !!nonMobileMaintenanceEvent,
        operationalStatus: eq.operationalStatus || 'operating',
        shouldResetOperationalStatus,
        needsRbFailed,
        pendingInspectionId: eq.pendingInspectionId || null
      });
    }

    if (!apply) continue;

    if (mobileMaintenanceEvents.length) {
      const removed = await MaintenanceEvent.deleteMany({
        tenantId: eq.tenantId,
        equipmentId: eq._id,
        kind: 'fault_reported',
        source: { $in: ['mobileSync', 'mobileSyncBackfill'] }
      });
      report.removedMobileMaintenanceEvents += removed.deletedCount || 0;
    }

    if (shouldResetOperationalStatus) {
      eq.operationalStatus = 'operating';
      eq.operationalStatusChangedAt = null;
      eq.operationalStatusChangedBy = null;
      eq.ModifiedBy = actorId;
    }

    if (needsRbFailed) {
      const rbSchema = await ensureRbSchema({ userId: actorId });
      ensureRbAssignment(eq, rbSchema, { ...getRbValues(eq), compliance: 'Failed' }, actorId);
      if (eq.markModified) eq.markModified('schemaAssignments');
      eq.ModifiedBy = actorId;
      report.setRbFailed += 1;
    }

    if (shouldResetOperationalStatus || needsRbFailed) {
      await eq.save();
    }
    if (shouldResetOperationalStatus) report.resetOperationalStatus += 1;

    if (needsPendingInspection) {
      await ensureAutoInspectionFromMobileSync({
        equipmentDoc: eq,
        tenantId: eq.tenantId,
        userId: actorId,
        failureNoteFromJob: 'Mobile fault report.',
        failureSeverityFromJob: null
      });
      report.createdPendingInspections += 1;
    }

    if (noisyVersionIds.length) {
      const removed = await EquipmentDataVersion.deleteMany({
        _id: { $in: noisyVersionIds },
        tenantId: eq.tenantId,
        equipmentId: eq._id
      });
      report.removedHistoryNoise += removed.deletedCount || 0;
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {}
  });
