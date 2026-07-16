const UploadBatch = require('../models/uploadBatch');
const certificateDraftController = require('../controllers/certificateDraftController');
const logger = require('../config/logger');
const { withLock } = require('./distributedLockService');

let timer = null;
let running = false;
let stopping = false;
let emptyPolls = 0;
let lastStaleRecoveryAt = 0;

const STALE_RECOVERY_INTERVAL_MS = Math.max(60_000, Number(process.env.CERT_DRAFT_STALE_RECOVERY_MS || 5 * 60_000));

function getPollMs() {
  const n = Number(process.env.CERT_DRAFT_WORKER_POLL_MS || 5000);
  return Number.isFinite(n) && n >= 1000 ? Math.min(Math.floor(n), 60000) : 5000;
}

function getStaleMinutes() {
  const n = Number(process.env.CERT_DRAFT_STALE_MINUTES || 120);
  return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 120;
}

async function recoverStaleDraftBatches() {
  const staleBefore = new Date(Date.now() - getStaleMinutes() * 60 * 1000);
  await UploadBatch.updateMany(
    {
      processingStatus: 'processing',
      processingStartedAt: { $lte: staleBefore }
    },
    {
      $set: {
        processingStatus: 'queued',
        processingError: `Retrying stale draft batch after ${getStaleMinutes()} minutes without completion.`
      }
    }
  );
}

async function claimNextDraftBatch() {
  return UploadBatch.findOneAndUpdate(
    { processingStatus: 'queued' },
    {
      $set: {
        processingStatus: 'processing',
        processingStartedAt: new Date(),
        processingFinishedAt: null,
        processingError: ''
      }
    },
    {
      sort: { processingRequestedAt: 1, createdAt: 1 },
      new: true
    }
  ).lean();
}

async function processClaimedBatch(batch) {
  const uploadId = String(batch?.uploadId || '');
  if (!uploadId) return;
  try {
    await certificateDraftController.processDraftUploadBatch(uploadId, {
      statuses: Array.isArray(batch.processingStatuses) && batch.processingStatuses.length
        ? batch.processingStatuses
        : ['draft']
    });
    await UploadBatch.updateOne(
      { uploadId },
      {
        $set: {
          processingStatus: 'done',
          processingFinishedAt: new Date(),
          processingError: ''
        }
      }
    );
  } catch (err) {
    await UploadBatch.updateOne(
      { uploadId },
      {
        $set: {
          processingStatus: 'error',
          processingFinishedAt: new Date(),
          processingError: err?.message || 'Draft batch processing failed'
        }
      }
    );
    logger.warn('[certificate-draft-worker] batch failed', {
      uploadId,
      error: err?.message || String(err)
    });
  }
}

async function pollCertificateDraftBatches() {
  if (running) return false;
  running = true;
  try {
    if (Date.now() - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      await recoverStaleDraftBatches();
      lastStaleRecoveryAt = Date.now();
    }
    const batch = await claimNextDraftBatch();
    if (batch) await processClaimedBatch(batch);
    return Boolean(batch);
  } catch (err) {
    logger.warn('[certificate-draft-worker] poll failed', { error: err?.message || String(err) });
    return false;
  } finally {
    running = false;
  }
}

function scheduleNext(baseMs, delayMs = baseMs) {
  if (stopping) return;
  timer = setTimeout(async () => {
    try {
      const didWork = await withLock('worker:certificate-draft:poll', Math.max(baseMs * 4, 60_000), pollCertificateDraftBatches);
      emptyPolls = didWork ? 0 : Math.min(emptyPolls + 1, 2);
    } catch (err) {
      emptyPolls = Math.min(emptyPolls + 1, 2);
      logger.warn('[certificate-draft-worker] lock failed', { error: err?.message || String(err) });
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
  scheduleNext(intervalMs, Number(options.initialDelayMs || 4500));
  logger.info('[certificate-draft-worker] started', { intervalMs });
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
  pollCertificateDraftBatches
};
