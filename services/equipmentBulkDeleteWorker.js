const EquipmentBulkDeleteJob = require('../models/equipmentBulkDeleteJob');
const exRegisterController = require('../controllers/exRegisterController');
const logger = require('../config/logger');
const { withLock } = require('./distributedLockService');

let timer = null;
let running = false;
let stopping = false;
let emptyPolls = 0;
let lastStaleRecoveryAt = 0;

const STALE_RECOVERY_INTERVAL_MS = Math.max(60_000, Number(process.env.EQUIPMENT_BULK_DELETE_STALE_RECOVERY_MS || 5 * 60_000));

function getPollMs() {
  const n = Number(process.env.EQUIPMENT_BULK_DELETE_WORKER_POLL_MS || 5000);
  return Number.isFinite(n) && n >= 1000 ? Math.min(Math.floor(n), 60000) : 5000;
}

function getStaleMinutes() {
  const n = Number(process.env.EQUIPMENT_BULK_DELETE_STALE_MINUTES || 15);
  return Number.isFinite(n) && n >= 5 ? Math.floor(n) : 15;
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - getStaleMinutes() * 60 * 1000);
  await EquipmentBulkDeleteJob.updateMany(
    {
      status: 'running',
      $or: [
        { lastHeartbeatAt: { $lte: staleBefore } },
        { lastHeartbeatAt: null, startedAt: { $lte: staleBefore } }
      ]
    },
    { $set: { status: 'queued', errorMessage: `Retrying stale bulk delete job after ${getStaleMinutes()} minutes without completion.` } }
  );
}

async function pollEquipmentBulkDeleteJobs() {
  if (running) return false;
  running = true;
  try {
    if (Date.now() - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      await recoverStaleJobs();
      lastStaleRecoveryAt = Date.now();
    }
    const jobs = await EquipmentBulkDeleteJob.find({ status: 'queued' })
      .sort({ updatedAt: 1, createdAt: 1 })
      .select('_id')
      .limit(2)
      .lean();
    for (const job of jobs || []) {
      await exRegisterController.processEquipmentBulkDeleteJob(job._id);
    }
    return jobs.length > 0;
  } catch (err) {
    logger.warn('[equipment-bulk-delete-worker] poll failed', { error: err?.message || String(err) });
    return false;
  } finally {
    running = false;
  }
}

function scheduleNext(baseMs, delayMs = baseMs) {
  if (stopping) return;
  timer = setTimeout(async () => {
    try {
      const didWork = await withLock('worker:equipment-bulk-delete:poll', Math.max(baseMs * 4, 60_000), pollEquipmentBulkDeleteJobs);
      emptyPolls = didWork ? 0 : Math.min(emptyPolls + 1, 2);
    } catch (err) {
      emptyPolls = Math.min(emptyPolls + 1, 2);
      logger.warn('[equipment-bulk-delete-worker] lock failed', { error: err?.message || String(err) });
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
  logger.info('[equipment-bulk-delete-worker] started', { intervalMs });
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

module.exports = { start, stop, pollEquipmentBulkDeleteJobs };
