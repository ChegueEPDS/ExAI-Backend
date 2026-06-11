const cleanupService = require('./cleanupService');
const subscriptionSweeper = require('./subscriptionSweeper');
const reportExportCleanup = require('./reportExportCleanup');
const mobileSyncWorker = require('./mobileSyncWorker');
const certificatePreviewWorker = require('./certificatePreviewWorker');
const certificateDraftWorker = require('./certificateDraftWorker');
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
    () => withLock('subscriptions:sweep-expired', 20 * 60 * 1000, subscriptionSweeper.sweepExpiredSubscriptions),
    60 * 60 * 1000
  );

  mobileSyncWorker.start({ intervalMs: 5000 });

  logger.info('[worker-runtime] started', {
    timers: timers.length,
    reportExportWorker: true,
    reportExportCleanup: true,
    certificatePreviewWorker: true,
    certificateDraftWorker: true,
    mobileSyncWorker: true
  });

  return { started: true };
}

module.exports = {
  backgroundJobsDisabled,
  startWorkerRuntime
};
