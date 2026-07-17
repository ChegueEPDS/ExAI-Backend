const ProcessingJob = require('../models/processingJob');
const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const Tenant = require('../models/tenant');
const axios = require('axios');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { processDataplateForEquipment } = require('./dataplateProcessingService');
const { complianceStatus } = require('./rbSchemaValueService');
const { withLock } = require('./distributedLockService');
const { generateInspectionResultsForEquipment } = require('./inspectionResultGenerator');

let isRunning = false;
let pollTimer = null;
let emptyPolls = 0;
let lastStaleRecoveryAt = 0;
let stopping = false;
const STALE_RECOVERY_INTERVAL_MS = Math.max(60_000, Number(process.env.MOBILE_SYNC_STALE_RECOVERY_MS || 5 * 60_000));

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function summarizeAutoInspectionResults(results) {
  const summary = { failedCount: 0, naCount: 0, passedCount: 0 };
  results.forEach((r) => {
    if (r.status === 'Failed') summary.failedCount += 1;
    else if (r.status === 'NA') summary.naCount += 1;
    else summary.passedCount += 1;
  });
  return { summary, status: summary.failedCount > 0 ? 'Failed' : 'Passed' };
}

function deriveQuestionReference(input = {}) {
  const explicit = String(input.reference || '').trim();
  if (explicit) return explicit;
  const table = String(input.table || input.Table || '').trim();
  const number = input.number ?? input.Number;
  if (table === 'SC' || input.equipmentType === 'Special Condition') return `SC${number || 1}`;
  if (table && (number || number === 0)) return `${table}-${number}`;
  if (number || number === 0) return `${number}`;
  return '';
}

function truncate(s, max = 200) {
  const txt = String(s || '').replace(/\s+/g, ' ').trim();
  if (txt.length <= max) return txt;
  return `${txt.slice(0, max - 1)}…`;
}

async function chooseFailureTargetKey({ failureNote, candidates }) {
  const note = String(failureNote || '').trim();
  if (!note) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const list = candidates.map((c) => ({
    key: c.key,
    table: c.table,
    group: c.group,
    number: c.number,
    equipmentType: c.equipmentType,
    text: truncate(c.text, 180)
  }));

  try {
    const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');
    const allowedKeys = candidates.map((c) => c.key);
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', enum: allowedKeys.slice(0, 200) },
      },
      required: ['key'],
    };

    const respObj = await createResponse({
      model: 'gpt-4o-mini',
      instructions:
        'You map a failure note to the single most relevant inspection question. Return STRICT JSON only.',
      input: [{
        role: 'user',
        content: JSON.stringify({ failureNote: note, candidates: list }),
      }],
      store: false,
      temperature: 0,
      maxOutputTokens: 120,
      textFormat: { type: 'json_schema', name: 'failure_key', strict: true, schema },
      timeoutMs: 60_000,
    });

    const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
    const json = JSON.parse(txt);
    const key = typeof json?.key === 'string' ? json.key.trim() : '';
    if (!key) return null;
    const allowed = new Set(candidates.map((c) => c.key));
    return allowed.has(key) ? key : null;
  } catch {
    return null;
  }
}

function normalizeInspectionSeverity(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return ['P1', 'P2', 'P3', 'P4'].includes(normalized) ? normalized : null;
}

async function ensureAutoInspectionFromMobileSync({
  equipmentDoc,
  tenantId,
  userId,
  failureNoteFromJob,
  failureSeverityFromJob
}) {
  const already = equipmentDoc.pendingInspectionId
    ? await Inspection.findOne({ _id: equipmentDoc.pendingInspectionId, tenantId }).select('_id').lean()
    : null;
  if (already) return;

  const compliance = complianceStatus(equipmentDoc);
  if (compliance !== 'Passed' && compliance !== 'Failed') return;

  const inspectionDate = new Date();
  const validUntil = addYears(inspectionDate, 3);

  const inspectionType = 'Detailed';
  let results = await generateInspectionResultsForEquipment({
    equipmentDoc,
    tenantId,
    inspectionType
  });
  results = results.map((r) => ({ ...r, reference: deriveQuestionReference(r) }));

  if (compliance === 'Failed') {
    const failureNoteRaw = String(failureNoteFromJob || '').trim();
    const failureNote = failureNoteRaw || 'Failed (no failure note provided).';
    const failureSeverity = normalizeInspectionSeverity(failureSeverityFromJob);
    const passedCandidates = results
      .filter((r) => r.status === 'Passed' && r.table !== 'SC')
      .slice(0, 80)
      .map((r) => ({
        key: `${r.table}__${r.group}__${r.number ?? ''}__${r.questionId ? String(r.questionId) : ''}`,
        table: r.table,
        group: r.group,
        number: r.number,
        equipmentType: r.equipmentType,
        text: r.questionText?.eng || r.questionText?.hun || ''
      }));

    const targetKey =
      (failureNoteRaw ? await chooseFailureTargetKey({ failureNote: failureNoteRaw, candidates: passedCandidates }) : null) ||
      (passedCandidates.length ? passedCandidates[0].key : null);

    if (targetKey) {
      const allowed = new Set(passedCandidates.map((c) => c.key));
      if (allowed.has(targetKey)) {
        results = results.map((r) => {
          const k = `${r.table}__${r.group}__${r.number ?? ''}__${r.questionId ? String(r.questionId) : ''}`;
          if (k !== targetKey) return r;
          return { ...r, status: 'Failed', note: failureNote, severity: failureSeverity };
        });
      }
    }
  }

  const { summary, status } = summarizeAutoInspectionResults(results);

  const failedResults = results.filter((r) => r.status === 'Failed');
  const attachments = [];
  if (failedResults.length) {
    const docs = Array.isArray(equipmentDoc.documents) ? equipmentDoc.documents : [];
    const pics = Array.isArray(equipmentDoc.Pictures) ? equipmentDoc.Pictures : [];
    const faultDocs = docs.filter((d) => String(d?.tag || '').toLowerCase() === 'fault' && (d.blobPath || d.blobUrl));
    const faultPics = pics.filter((p) => String(p?.tag || '').toLowerCase() === 'fault' && (p.blobPath || p.blobUrl));
    const allFault = [...faultDocs, ...faultPics];

    failedResults.forEach((r) => {
      const questionKey =
        r.table === 'SC' || r.equipmentType === 'Special Condition'
          ? `SC${r.number || 1}`
          : r.table && r.group && (r.number ?? null) != null
            ? `${r.table}-${r.group}-${r.number}`
            : undefined;

      allFault.forEach((f) => {
        const blobPath = f.blobPath || f.blobUrl;
        const blobUrl = f.blobUrl || undefined;
        if (!blobPath || !blobUrl) return;
        attachments.push({
          blobPath,
          blobUrl,
          type: 'image',
          contentType: f.contentType || 'image/*',
          size: f.size ?? null,
          questionId: r.questionId || undefined,
          questionKey,
          note: 'Mobile failure photo',
          createdBy: userId
        });
      });
    });
  }

  const inspection = new Inspection({
    equipmentId: equipmentDoc._id,
    eqId: equipmentDoc.EqID || String(equipmentDoc._id),
    tenantId,
    siteId: equipmentDoc.Site || null,
    zoneId: equipmentDoc.Unit || equipmentDoc.Zone || null,
    inspectionDate,
    validUntil,
    inspectionType,
    inspectorId: userId,
    results,
    attachments,
    summary,
    status,
    failureSeverity: status === 'Failed' ? normalizeInspectionSeverity(failureSeverityFromJob) : null,
    reviewStatus: 'pending',
    source: 'mobileSync'
  });

  await inspection.save();

  equipmentDoc.pendingReview = true;
  equipmentDoc.pendingInspectionId = inspection._id;
  await equipmentDoc.save();
}

async function processOneJob(job) {
  const tenantId = job.tenantId;
  const userId = job.createdBy;
  const equipmentIds = Array.isArray(job.equipmentIds) ? job.equipmentIds : [];
  const metaByEquipmentId = job?.metaByEquipmentId && typeof job.metaByEquipmentId === 'object' ? job.metaByEquipmentId : {};
  const tenant = tenantId ? await Tenant.findById(tenantId).select('name').lean() : null;
  const tenantKey = String(tenant?.name || '').toLowerCase();
  const concurrency = Math.max(1, Math.min(Number(process.env.MOBILE_SYNC_CONCURRENCY || 1), 4));
  let nextIndex = 0;
  let processedCount = 0;

  async function markProcessed() {
    processedCount += 1;
    await ProcessingJob.updateOne({ _id: job._id }, { $set: { processed: processedCount } });
  }

  async function processEquipment(equipmentId) {
    try {
      const equipmentDoc = await Equipment.findOne({ _id: equipmentId, tenantId });
      if (!equipmentDoc) {
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $push: { errorItems: { equipmentId, message: 'Equipment not found for tenant.' } }
          }
        );
        await markProcessed();
        return;
      }

      equipmentDoc.mobileSync = {
        ...(equipmentDoc.mobileSync && typeof equipmentDoc.mobileSync === 'object' ? equipmentDoc.mobileSync : {}),
        jobId: equipmentDoc.mobileSync?.jobId || String(job._id),
        status: 'processing'
      };
      equipmentDoc.isProcessed = false;
      try {
        await equipmentDoc.save();
      } catch {
        // ignore
      }

      let hadErrors = false;
      const itemMeta = metaByEquipmentId?.[String(equipmentId)] || {};
      const skipDataplateProcessing = itemMeta?.skipDataplateProcessing === true;

      // Dataplate reader: OCR -> assistant table -> fill fields (only if empty).
      if (!skipDataplateProcessing) {
        try {
          const r = await processDataplateForEquipment({ equipmentDoc, tenantId, tenantKey, userId });
          if (!r?.processed) {
            hadErrors = true;
            const reason = String(r?.reason || 'unknown');
            const message =
              reason === 'no_dataplate_image'
                ? 'No dataplate-tagged image found. Tag one photo as "dataplate" in the mobile app.'
                : `Dataplate processing skipped/failed: ${reason}`;
            await ProcessingJob.updateOne(
              { _id: job._id },
              {
                $push: {
                  errorItems: {
                    equipmentId,
                    message
                  }
                }
              }
            );
          }
        } catch (e) {
          hadErrors = true;
          await ProcessingJob.updateOne(
            { _id: job._id },
            {
              $push: {
                errorItems: {
                  equipmentId,
                  message: `Dataplate processing failed: ${e?.message || String(e)}`
                }
              }
            }
          );
        }
      }

      // Auto inspection for mobile-created equipment or mobile failure reports (Passed or Failed).
      try {
        const failureNoteFromJob = itemMeta?.failureNote;
        const failureSeverityFromJob = itemMeta?.failureSeverity;
        await ensureAutoInspectionFromMobileSync({
          equipmentDoc,
          tenantId,
          userId,
          failureNoteFromJob,
          failureSeverityFromJob
        });
      } catch (e) {
        hadErrors = true;
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $push: {
              errorItems: {
                equipmentId,
                message: `Auto inspection failed: ${e?.message || String(e)}`
              }
            }
          }
        );
      }

      // Mark equipment visible in exregister now that processing is finished (even if there were errors).
      equipmentDoc.mobileSync = {
        ...(equipmentDoc.mobileSync && typeof equipmentDoc.mobileSync === 'object' ? equipmentDoc.mobileSync : {}),
        jobId: equipmentDoc.mobileSync?.jobId || String(job._id),
        status: hadErrors ? 'error' : 'done',
        finishedAt: new Date()
      };
      equipmentDoc.isProcessed = true;
      try {
        await equipmentDoc.save();
      } catch {
        // ignore
      }

      await markProcessed();
    } catch (err) {
      await ProcessingJob.updateOne(
        { _id: job._id },
        {
          $push: { errorItems: { equipmentId, message: err?.message || String(err) } }
        }
      );
      await markProcessed();
    }
  }

  async function worker() {
    while (nextIndex < equipmentIds.length) {
      const current = nextIndex;
      nextIndex += 1;
      await processEquipment(equipmentIds[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, equipmentIds.length || 1) }, () => worker());
  await Promise.all(workers);
}

async function tick() {
  if (isRunning) return false;
  isRunning = true;
  let job = null;
  try {
    const now = new Date();
    if (Date.now() - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      const staleMinutes = Math.max(Number(process.env.MOBILE_SYNC_STALE_MINUTES || 120), 15);
      const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000);
      const staleJobs = await ProcessingJob.find({
        type: 'mobileSync',
        status: 'processing',
        startedAt: { $lte: staleBefore }
      }).select('_id tenantId equipmentIds').lean();
      for (const staleJob of staleJobs || []) {
        await ProcessingJob.updateOne(
          { _id: staleJob._id, status: 'processing' },
          {
            $set: {
              status: 'error',
              finishedAt: now,
              errorMessage: `Mobile sync job exceeded ${staleMinutes} minutes without finishing.`
            }
          }
        );
        await Equipment.updateMany(
          {
            _id: { $in: staleJob.equipmentIds || [] },
            tenantId: staleJob.tenantId,
            'mobileSync.jobId': String(staleJob._id)
          },
          {
            $set: {
              'mobileSync.status': 'error',
              'mobileSync.finishedAt': now,
              isProcessed: true
            }
          }
        );
      }
      lastStaleRecoveryAt = Date.now();
    }
    job = await ProcessingJob.findOneAndUpdate(
      { type: 'mobileSync', status: 'queued' },
      { $set: { status: 'processing', startedAt: now } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!job) return false;

    try {
      console.info('[mobile-sync-worker] job picked', {
        jobId: String(job._id),
        tenantId: String(job.tenantId || ''),
        total: job.total || (Array.isArray(job.equipmentIds) ? job.equipmentIds.length : 0)
      });
    } catch {}

    // Best-effort: mark all equipment in this job as "processing" (hidden).
    try {
      await Equipment.updateMany(
        { _id: { $in: job.equipmentIds || [] }, tenantId: job.tenantId },
        { $set: { 'mobileSync.jobId': String(job._id), 'mobileSync.status': 'processing', isProcessed: false } }
      );
    } catch {
      // ignore
    }

    await processOneJob(job);

    const refreshed = await ProcessingJob.findById(job._id).select('errorItems createdBy tenantId total processed').lean();
    const hasErrors = Array.isArray(refreshed?.errorItems) && refreshed.errorItems.length > 0;
    await ProcessingJob.updateOne(
      { _id: job._id },
      { $set: { status: hasErrors ? 'error' : 'done', finishedAt: new Date() } }
    );

    try {
      console.info('[mobile-sync-worker] job finished', {
        jobId: String(job._id),
        tenantId: String(refreshed?.tenantId || ''),
        status: hasErrors ? 'error' : 'done',
        processed: refreshed?.processed || 0,
        total: refreshed?.total || 0,
        errors: Array.isArray(refreshed?.errorItems) ? refreshed.errorItems.length : 0
      });
    } catch {}

    // Notify user about completion (mobile can show this via notifications list)
    try {
      await notifyAndStore(String(refreshed.createdBy), {
        type: 'mobile-sync',
        title: 'Mobile sync',
        message: hasErrors ? 'Mobile sync finished with errors.' : 'Mobile sync finished successfully.',
        data: {
          jobId: String(job._id),
          jobType: 'mobileSync',
          status: hasErrors ? 'error' : 'done',
          processed: refreshed.processed,
          total: refreshed.total,
          errors: refreshed.errorItems || []
        },
        meta: { route: '/notifications', jobId: String(job._id) }
      });
    } catch {
      // ignore notification failures
    }
    return true;
  } catch (err) {
    if (job?._id) {
      try {
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'error',
              finishedAt: new Date(),
              errorMessage: err?.message || String(err)
            }
          }
        );
      } catch {
        // Best-effort failure marking; worker must not crash the server.
      }
    }
    return false;
  } finally {
    isRunning = false;
  }
}

function start({ intervalMs = 5000 } = {}) {
  if (pollTimer) return { started: false, reason: 'already_started' };
  const baseMs = Math.max(1000, Number(intervalMs) || 5000);
  stopping = false;
  const scheduleNext = (delayMs) => {
    if (stopping) return;
    pollTimer = setTimeout(async () => {
      try {
        const didWork = await withLock('worker:mobile-sync:poll', Math.max(baseMs * 4, 60_000), tick);
        emptyPolls = didWork ? 0 : Math.min(emptyPolls + 1, 2);
      } catch {
        emptyPolls = Math.min(emptyPolls + 1, 2);
      }
      const nextDelay = emptyPolls === 0 ? baseMs : (emptyPolls === 1 ? Math.max(baseMs, 10_000) : Math.max(baseMs, 30_000));
      if (!stopping) scheduleNext(nextDelay);
    }, delayMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  };
  scheduleNext(1500);
  return { started: true };
}

async function stop({ drainTimeoutMs = 120_000 } = {}) {
  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  const deadline = Date.now() + Math.max(0, Number(drainTimeoutMs) || 0);
  while (isRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { drained: !isRunning };
}

module.exports = { start, stop, ensureAutoInspectionFromMobileSync };
