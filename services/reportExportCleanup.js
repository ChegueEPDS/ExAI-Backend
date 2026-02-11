const ReportExportJob = require('../models/reportExportJob');
const azureBlob = require('./azureBlobService');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');

function getRetentionDays() {
  const n = Number(systemSettings.getNumber('REPORT_EXPORT_RETENTION_DAYS'));
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function getCleanupIntervalMs() {
  const n = Number(systemSettings.getNumber('REPORT_EXPORT_CLEANUP_INTERVAL_MS'));
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

let timer = null;
let running = false;

async function cleanupOnce(batchSize = 50) {
  const retentionDays = getRetentionDays();
  if (!retentionDays || retentionDays <= 0) return;
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    while (true) {
      const jobs = await ReportExportJob.find({
        finishedAt: { $lte: cutoff },
        status: { $in: ['succeeded', 'failed'] }
      })
        .sort({ finishedAt: 1 })
        .limit(batchSize)
        .lean();

      if (!jobs.length) break;

      for (const job of jobs) {
        if (job.blobPath) {
          try {
            await azureBlob.deleteFile(job.blobPath);
          } catch (err) {
            logger.warn('[report-export] Failed to delete blob during cleanup', {
              jobId: job.jobId,
              err: err?.message || err
            });
          }
        }
        await ReportExportJob.deleteOne({ _id: job._id });
      }

      logger.info('[report-export] cleanup removed %d jobs older than %d days', jobs.length, retentionDays);
      if (jobs.length < batchSize) {
        break;
      }
    }
  } catch (err) {
    logger.error('[report-export] cleanup failed', err);
  } finally {
    running = false;
  }
}

function start() {
  const retentionDays = getRetentionDays();
  if (timer || !retentionDays) return;

  const clampInterval = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return 60 * 60 * 1000;
    // avoid accidental tight loops
    return Math.max(10_000, n);
  };

  const scheduleNext = (delayMs) => {
    const delay = clampInterval(delayMs);
    timer = setTimeout(async () => {
      timer = null;
      try {
        await cleanupOnce();
      } catch (err) {
        logger.error('[report-export] cleanup schedule error', err);
      } finally {
        // Re-read interval each time so changes apply without restart.
        scheduleNext(getCleanupIntervalMs());
      }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  };

  scheduleNext(getCleanupIntervalMs());

  // kick off after startup
  setTimeout(() => cleanupOnce().catch(err => logger.error('[report-export] initial cleanup error', err)), 15 * 1000);

  logger.info(
    '[report-export] cleanup scheduler started (dynamic interval, current %d ms, retention %d days)',
    clampInterval(getCleanupIntervalMs()),
    retentionDays
  );
}

module.exports = { start, cleanupOnce };
