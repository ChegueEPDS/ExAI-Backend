const ProcessingJob = require('../models/processingJob');
const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const Tenant = require('../models/tenant');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { processDataplateForEquipment } = require('./dataplateProcessingService');

let isRunning = false;

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

async function ensurePassedInspectionSimple({ equipmentDoc, tenantId, userId }) {
  const already = equipmentDoc.lastInspectionId
    ? await Inspection.findOne({ _id: equipmentDoc.lastInspectionId, tenantId }).select('_id').lean()
    : null;
  if (already) return;

  const inspectionDate = new Date();
  const validUntil = addYears(inspectionDate, 3);

  const inspection = new Inspection({
    equipmentId: equipmentDoc._id,
    eqId: equipmentDoc.EqID || String(equipmentDoc._id),
    tenantId,
    siteId: equipmentDoc.Site || null,
    zoneId: equipmentDoc.Zone || null,
    inspectionDate,
    validUntil,
    inspectionType: 'Detailed',
    inspectorId: userId,
    results: [
      {
        status: 'Passed',
        note: 'Automatically created after mobile sync (Compliance=Passed).',
        table: 'AUTO',
        group: 'AUTO',
        number: 1,
        equipmentType: equipmentDoc['Equipment Type'] || '',
        protectionTypes: [],
        questionText: {
          eng: 'Auto-generated inspection after mobile sync.',
          hun: 'Automatikus ellenőrzés mobil szinkron után.'
        }
      }
    ],
    attachments: [],
    summary: { failedCount: 0, naCount: 0, passedCount: 1 },
    status: 'Passed'
  });

  await inspection.save();

  equipmentDoc.lastInspectionDate = inspectionDate;
  equipmentDoc.lastInspectionValidUntil = validUntil;
  equipmentDoc.lastInspectionStatus = 'Passed';
  equipmentDoc.lastInspectionId = inspection._id;
  await equipmentDoc.save();
}

async function processOneJob(job) {
  const tenantId = job.tenantId;
  const userId = job.createdBy;
  const equipmentIds = Array.isArray(job.equipmentIds) ? job.equipmentIds : [];
  const tenant = tenantId ? await Tenant.findById(tenantId).select('name').lean() : null;
  const tenantKey = String(tenant?.name || '').toLowerCase();

  for (let i = 0; i < equipmentIds.length; i += 1) {
    const equipmentId = equipmentIds[i];
    try {
      const equipmentDoc = await Equipment.findOne({ _id: equipmentId, tenantId });
      if (!equipmentDoc) {
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $push: { errorItems: { equipmentId, message: 'Equipment not found for tenant.' } },
            $set: { processed: i + 1 }
          }
        );
        continue;
      }

      // Dataplate reader: OCR -> assistant table -> fill fields (only if empty).
      try {
        await processDataplateForEquipment({ equipmentDoc, tenantKey, userId });
      } catch (e) {
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $push: {
              errorItems: {
                equipmentId,
                message: `Dataplate processing failed: ${e?.message || String(e)}`
              }
            }
          }
        );
      }

      // Ensure "Passed" inspections if requested by Compliance.
      if (String(equipmentDoc.Compliance) === 'Passed') {
        await ensurePassedInspectionSimple({ equipmentDoc, tenantId, userId });
      }

      await ProcessingJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } });
    } catch (err) {
      await ProcessingJob.updateOne(
        { _id: job._id },
        {
          $push: { errorItems: { equipmentId, message: err?.message || String(err) } },
          $set: { processed: i + 1 }
        }
      );
    }
  }
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const job = await ProcessingJob.findOneAndUpdate(
      { type: 'mobileSync', status: 'queued' },
      { $set: { status: 'processing', startedAt: now } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!job) return;

    await processOneJob(job);

    const refreshed = await ProcessingJob.findById(job._id).select('errorItems createdBy tenantId total processed').lean();
    const hasErrors = Array.isArray(refreshed?.errorItems) && refreshed.errorItems.length > 0;
    await ProcessingJob.updateOne(
      { _id: job._id },
      { $set: { status: hasErrors ? 'error' : 'done', finishedAt: new Date() } }
    );

    // Notify user about completion (mobile can show this via notifications list)
    try {
      await notifyAndStore(String(refreshed.createdBy), {
        type: 'mobile-sync',
        title: 'Mobile sync',
        message: hasErrors ? 'Mobile sync finished with errors.' : 'Mobile sync finished successfully.',
        data: {
          jobId: String(job._id),
          jobType: 'mobileSync',
          status: hasErrors ? 'error' : 'done',
          processed: refreshed.processed,
          total: refreshed.total,
          errors: refreshed.errorItems || []
        },
        meta: { route: '/notifications', jobId: String(job._id) }
      });
    } catch {
      // ignore notification failures
    }
  } catch (err) {
    // If we ever fail mid-update, we keep the current job in 'processing' and it can be handled manually.
    // This worker is best-effort and should not crash the server.
  } finally {
    isRunning = false;
  }
}

function start({ intervalMs = 5000 } = {}) {
  setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  // also run soon after boot
  setTimeout(() => tick().catch(() => {}), 1500);
}

module.exports = { start };
