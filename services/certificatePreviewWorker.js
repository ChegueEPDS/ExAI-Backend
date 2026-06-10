const CertificatePreviewJob = require('../models/certificatePreviewJob');
const certificateController = require('../controllers/certificateController');
const logger = require('../config/logger');

let timer = null;
let running = false;

function getPollMs() {
  const n = Number(process.env.CERT_PREVIEW_WORKER_POLL_MS || 5000);
  return Number.isFinite(n) && n >= 1000 ? Math.min(Math.floor(n), 60000) : 5000;
}

function getStaleMinutes() {
  const n = Number(process.env.CERT_PREVIEW_STALE_MINUTES || 120);
  return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 120;
}

async function recoverStalePreviewJobs() {
  const staleBefore = new Date(Date.now() - getStaleMinutes() * 60 * 1000);
  await CertificatePreviewJob.updateMany(
    {
      status: 'processing',
      startedAt: { $lte: staleBefore }
    },
    {
      $set: {
        status: 'queued',
        error: `Retrying stale preview job after ${getStaleMinutes()} minutes without completion.`
      }
    }
  );
}

async function pollCertificatePreviewJobs() {
  if (running) return;
  running = true;
  try {
    await recoverStalePreviewJobs();
    const jobs = await CertificatePreviewJob.find({ status: 'queued' })
      .sort({ updatedAt: 1, createdAt: 1 })
      .select('_id')
      .limit(5)
      .lean();

    for (const job of jobs || []) {
      await certificateController.processCertificatePreviewJob(job._id);
    }
  } catch (err) {
    logger.warn('[certificate-preview-worker] poll failed', { error: err?.message || String(err) });
  } finally {
    running = false;
  }
}

function start(options = {}) {
  if (timer) return { started: false, reason: 'already_started' };
  const intervalMs = Number(options.intervalMs || getPollMs());
  const firstRunTimer = setTimeout(() => pollCertificatePreviewJobs().catch(() => {}), 1500);
  if (typeof firstRunTimer.unref === 'function') firstRunTimer.unref();
  timer = setInterval(() => {
    pollCertificatePreviewJobs().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('[certificate-preview-worker] started', { intervalMs });
  return { started: true };
}

module.exports = {
  start,
  pollCertificatePreviewJobs
};
