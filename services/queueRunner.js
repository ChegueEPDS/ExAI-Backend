// services/queueRunner.js
const Conversation = require('../models/conversation'); // a módosított modell
const logger = require('../config/logger');
const jobBus = require('./jobBus');

// Ezt importáld be a service-ből, ne a controllerből (refaktor után).
// A “core” futtató függvény legyen egy tiszta service-függvény, ami nem függ a res-től.
// Itt most feltételezzük, hogy van egy ilyen:
const { runProjectSummaryCore } = require('./summaryCore'); 

let isRunning = false; // egyszerre csak egy job

async function pickNextQueued() {
  return Conversation.findOne({ 
    'backgroundJob.status': 'queued' 
  }).sort({ createdAt: 1 }).exec();
}

async function markRunning(conversation) {
  conversation.backgroundJob.status = 'running';
  conversation.backgroundJob.startedAt = new Date();
  await conversation.save();
}

async function markDone(conversation, ok, errorMessage) {
  conversation.backgroundJob.status = ok ? 'done' : 'failed';
  conversation.backgroundJob.finishedAt = new Date();
  if (!ok && errorMessage) {
    conversation.backgroundJob.error = errorMessage;
  }
  await conversation.save();
}

async function processOne(conv) {
  const threadId = conv.threadId;
  try {
    // Jelzés a klienseknek, hogy indul
    jobBus.emit(threadId, 'info', { stage: 'job.start' });
    await markRunning(conv);

    // A tényleges munka (tokenezés, chunkolás, OpenAI hívások, stb.)
    // runProjectSummaryCore NEM használ res.write()-ot, hanem a jobBus.emit-et kapja meg injektálva.
    await runProjectSummaryCore({
      threadId,
      conversationId: conv._id.toString(),
      filesMeta: conv.backgroundJob.filesMeta || [],
      userMessage: conv.backgroundJob.userMessage || 'Project summary. Please read all files and produce a single concise English summary including a file list.',
      emit: (event, payload) => jobBus.emit(threadId, event, payload), // így tud közben státuszokat küldeni
    });

    await markDone(conv, true);
    jobBus.emit(threadId, 'info', { stage: 'job.done' });
    jobBus.emit(threadId, 'done', {});
  } catch (err) {
    logger.error('Background job failed', { err });
    await markDone(conv, false, err?.message || 'Unknown error');
    jobBus.emit(threadId, 'error', { message: err?.message || 'Unknown error' });
    jobBus.emit(threadId, 'done', {});
  }
}

async function loopOnce() {
  if (isRunning) return;
  isRunning = true;
  try {
    const next = await pickNextQueued();
    if (!next) return; // nincs tennivaló

    await processOne(next);
  } finally {
    isRunning = false;
  }
}

function start({ intervalMs = 2000 } = {}) {
  // Periodikusan ellenőrzi, van-e queued feladat
  setInterval(loopOnce, intervalMs);
  logger.info(`QueueRunner started with interval ${intervalMs}ms`);
}

module.exports = { start, loopOnce };