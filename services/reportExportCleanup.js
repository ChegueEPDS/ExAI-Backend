const ReportExportJob = require('../models/reportExportJob');
const azureBlob = require('./azureBlobService');
const logger = require('../config/logger');

const RETENTION_DAYS =
  Number(process.env.REPORT_EXPORT_RETENTION_DAYS) > 0
    ? Number(process.env.REPORT_EXPORT_RETENTION_DAYS)
    : 90;
const CLEANUP_INTERVAL_MS =
  Number(process.env.REPORT_EXPORT_CLEANUP_INTERVAL_MS) > 0
    ? Number(process.env.REPORT_EXPORT_CLEANUP_INTERVAL_MS)
    : 6 * 60 * 60 * 1000; // 6 hours

let timer = null;
let running = false;

async function cleanupOnce(batchSize = 50) {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return;
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
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

      logger.info('[report-export] cleanup removed %d jobs older than %d days', jobs.length, RETENTION_DAYS);
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
  if (timer || !RETENTION_DAYS) return;
  timer = setInterval(() => {
    cleanupOnce().catch(err => logger.error('[report-export] cleanup schedule error', err));
  }, CLEANUP_INTERVAL_MS);
  // kick off after startup
  setTimeout(() => cleanupOnce().catch(err => logger.error('[report-export] initial cleanup error', err)), 15 * 1000);
  logger.info('[report-export] cleanup scheduler started (interval %d ms, retention %d days)', CLEANUP_INTERVAL_MS, RETENTION_DAYS);
}

module.exports = { start, cleanupOnce };
