const CertificatePreviewJob = require('../models/certificatePreviewJob');
const certificateController = require('../controllers/certificateController');
const logger = require('../config/logger');
const { withLock } = require('./distributedLockService');

let timer = null;
let running = false;
let stopping = false;
let emptyPolls = 0;
let lastStaleRecoveryAt = 0;

const STALE_RECOVERY_INTERVAL_MS = Math.max(60_000, Number(process.env.CERT_PREVIEW_STALE_RECOVERY_MS || 5 * 60_000));

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
  if (running) return false;
  running = true;
  try {
    if (Date.now() - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      await recoverStalePreviewJobs();
      lastStaleRecoveryAt = Date.now();
    }
    const jobs = await CertificatePreviewJob.find({ status: 'queued' })
      .sort({ updatedAt: 1, createdAt: 1 })
      .select('_id')
      .limit(5)
      .lean();

    for (const job of jobs || []) {
      await certificateController.processCertificatePreviewJob(job._id);
    }
    return jobs.length > 0;
  } catch (err) {
    logger.warn('[certificate-preview-worker] poll failed', { error: err?.message || String(err) });
    return false;
  } finally {
    running = false;
  }
}

function scheduleNext(baseMs, delayMs = baseMs) {
  if (stopping) return;
  timer = setTimeout(async () => {
    try {
      const didWork = await withLock('worker:certificate-preview:poll', Math.max(baseMs * 4, 60_000), pollCertificatePreviewJobs);
      emptyPolls = didWork ? 0 : Math.min(emptyPolls + 1, 2);
    } catch (err) {
      emptyPolls = Math.min(emptyPolls + 1, 2);
      logger.warn('[certificate-preview-worker] lock failed', { error: err?.message || String(err) });
    }
    const nextDelay = emptyPolls === 0 ? baseMs : (emptyPolls === 1 ? Math.max(baseMs, 10_000) : Math.max(baseMs, 30_000));
    if (!stopping) scheduleNext(baseMs, nextDelay);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function start(options = {}) {
  if (timer) return { started: false, reason: 'already_started' };
  const intervalMs = Number(options.intervalMs || getPollMs());
  stopping = false;
  scheduleNext(intervalMs, 1500);
  logger.info('[certificate-preview-worker] started', { intervalMs });
  return { started: true };
}

async function stop({ drainTimeoutMs = 120_000 } = {}) {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  const deadline = Date.now() + Math.max(0, Number(drainTimeoutMs) || 0);
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { drained: !running };
}

module.exports = {
  start,
  stop,
  pollCertificatePreviewJobs
};
