const UploadBatch = require('../models/uploadBatch');
const certificateDraftController = require('../controllers/certificateDraftController');
const logger = require('../config/logger');

let timer = null;
let running = false;

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
  if (running) return;
  running = true;
  try {
    await recoverStaleDraftBatches();
    const batch = await claimNextDraftBatch();
    if (batch) await processClaimedBatch(batch);
  } catch (err) {
    logger.warn('[certificate-draft-worker] poll failed', { error: err?.message || String(err) });
  } finally {
    running = false;
  }
}

function start(options = {}) {
  if (timer) return { started: false, reason: 'already_started' };
  const intervalMs = Number(options.intervalMs || getPollMs());
  const firstRunTimer = setTimeout(() => pollCertificateDraftBatches().catch(() => {}), 1500);
  if (typeof firstRunTimer.unref === 'function') firstRunTimer.unref();
  timer = setInterval(() => {
    pollCertificateDraftBatches().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('[certificate-draft-worker] started', { intervalMs });
  return { started: true };
}

module.exports = {
  start,
  pollCertificateDraftBatches
};
