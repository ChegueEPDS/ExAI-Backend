const cleanupService = require('./cleanupService');
const subscriptionSweeper = require('./subscriptionSweeper');
const reportExportCleanup = require('./reportExportCleanup');
const mobileSyncWorker = require('./mobileSyncWorker');
const certificatePreviewWorker = require('./certificatePreviewWorker');
const certificateDraftWorker = require('./certificateDraftWorker');
const equipmentImportWorker = require('./equipmentImportWorker');
const documentationExpiryNotifier = require('./documentationExpiryNotifier');
const reportExportController = require('../controllers/exportInspectionReport');
const { withLock } = require('./distributedLockService');
const logger = require('../config/logger');

let started = false;
const timers = [];

function backgroundJobsDisabled() {
  return (
    process.env.DISABLE_BACKGROUND_JOBS === '1' ||
    process.env.DISABLE_BACKGROUND_JOBS === 'true' ||
    process.env.NODE_ENV === 'test'
  );
}

function scheduleInterval(fn, intervalMs) {
  const timer = setInterval(fn, intervalMs);
  timers.push(timer);
  return timer;
}

function startWorkerRuntime() {
  if (started) return { started: false, reason: 'already_started' };
  if (backgroundJobsDisabled()) return { started: false, reason: 'disabled' };
  started = true;

  reportExportCleanup.start();
  reportExportController.startReportExportWorker?.();
  certificatePreviewWorker.start();
  certificateDraftWorker.start();
  equipmentImportWorker.start();

  scheduleInterval(
    () => withLock('cleanup:empty-conversations', 30 * 60 * 1000, cleanupService.removeEmptyConversations),
    3 * 60 * 60 * 1000
  );
  scheduleInterval(
    () => withLock('cleanup:upload-temp-files', 30 * 60 * 1000, () => cleanupService.cleanupUploadTempFiles()),
    3 * 60 * 60 * 1000
  );
  scheduleInterval(
    () => withLock('cleanup:equipment-doc-import-errors', 2 * 60 * 60 * 1000, cleanupService.cleanupEquipmentDocsImportErrorReports),
    24 * 60 * 60 * 1000
  );
  scheduleInterval(
    () => withLock('cleanup:equipment-import-jobs', 2 * 60 * 60 * 1000, cleanupService.cleanupEquipmentImportJobs),
    24 * 60 * 60 * 1000
  );
  scheduleInterval(
    () => withLock('subscriptions:sweep-expired', 20 * 60 * 1000, subscriptionSweeper.sweepExpiredSubscriptions),
    60 * 60 * 1000
  );
  scheduleInterval(
    () => withLock('documentations:expiry-notifications', 30 * 60 * 1000, documentationExpiryNotifier.sweepDocumentationExpiryNotifications),
    24 * 60 * 60 * 1000
  );
  withLock('documentations:expiry-notifications', 30 * 60 * 1000, documentationExpiryNotifier.sweepDocumentationExpiryNotifications)
    .catch((err) => logger.warn('[worker-runtime] documentation expiry sweep failed', err?.message || err));

  mobileSyncWorker.start({ intervalMs: 5000 });

  logger.info('[worker-runtime] started', {
    timers: timers.length,
    reportExportWorker: true,
    reportExportCleanup: true,
    certificatePreviewWorker: true,
    certificateDraftWorker: true,
    equipmentImportWorker: true,
    mobileSyncWorker: true,
    documentationExpiryNotifier: true
  });

  return { started: true };
}

async function stopWorkerRuntime({ drainTimeoutMs = 120_000 } = {}) {
  for (const timer of timers.splice(0, timers.length)) clearInterval(timer);
  const options = { drainTimeoutMs };
  const results = await Promise.allSettled([
    reportExportCleanup.stop?.(options),
    reportExportController.stopReportExportWorker?.(options),
    certificatePreviewWorker.stop?.(options),
    certificateDraftWorker.stop?.(options),
    equipmentImportWorker.stop?.(options),
    mobileSyncWorker.stop?.(options),
  ]);
  started = false;
  const drained = results.every((result) => result.status === 'fulfilled' && result.value?.drained !== false);
  logger.info('[worker-runtime] stopped', { drained });
  return { stopped: true, drained };
}

module.exports = {
  backgroundJobsDisabled,
  startWorkerRuntime,
  stopWorkerRuntime
};
