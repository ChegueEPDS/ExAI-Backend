const ProcessingJob = require('../models/processingJob');
const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const Tenant = require('../models/tenant');
const Question = require('../models/questions');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const mongoose = require('mongoose');
const axios = require('axios');
const { KNOWN_SET_LOWER, normalizeProtectionTypes } = require('../helpers/protectionTypes');
const { buildCertificateCacheForTenant, resolveCertificateFromCache } = require('../helpers/certificateMatchHelper');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { processDataplateForEquipment } = require('./dataplateProcessingService');

let isRunning = false;
const certCacheByTenant = new Map(); // tenantId -> { ts, map }

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractProtectionTypesFromEquipment(equipmentDoc) {
  const protection = equipmentDoc?.['Ex Marking']?.[0]?.['Type of Protection'] || '';
  if (!protection) return [];

  const tokens = normalizeProtectionTypes(protection).map((v) => String(v).trim().toLowerCase());
  const hasKnown = tokens.some((t) => KNOWN_SET_LOWER.has(t));
  if (!hasKnown && tokens.length) {
    return Array.from(new Set(['d', 'e', ...tokens]));
  }
  return tokens;
}

async function loadAutoInspectionQuestions(equipmentDoc, tenantId, inspectionType = 'Detailed') {
  try {
    const protections = extractProtectionTypesFromEquipment(equipmentDoc);
    const filter = {};
    const tenantObjectId = tenantId && mongoose.Types.ObjectId.isValid(tenantId) ? new mongoose.Types.ObjectId(tenantId) : null;
    if (tenantObjectId) filter.tenantId = tenantObjectId;

    if (protections.length) {
      filter.protectionTypes = {
        $in: protections.map((token) => new RegExp(`^${escapeRegex(token)}$`, 'i'))
      };
    }

    let questions = await Question.find(filter).lean();
    if ((!questions || !questions.length) && tenantObjectId) {
      const fallbackFilter = { ...filter };
      delete fallbackFilter.tenantId;
      questions = await Question.find(fallbackFilter).lean();
    }
    if (!Array.isArray(questions)) return [];

    return questions.filter((q) => {
      const types = Array.isArray(q.inspectionTypes) ? q.inspectionTypes : [];
      return !types.length || types.includes(inspectionType);
    });
  } catch (err) {
    return [];
  }
}

async function getRelevantEquipmentTypesForDevice(equipmentDoc, tenantId) {
  const rawType =
    (equipmentDoc && typeof equipmentDoc === 'object'
      ? equipmentDoc['Equipment Type'] || equipmentDoc.EquipmentType || ''
      : '') || '';

  const normalized = String(rawType).toLowerCase().trim();
  const result = new Set();
  if (!normalized) return result;

  const tenantObjectId = tenantId && mongoose.Types.ObjectId.isValid(tenantId) ? new mongoose.Types.ObjectId(tenantId) : null;
  if (!tenantObjectId) return result;

  try {
    const mappings = await QuestionTypeMapping.find({ tenantId: tenantObjectId, active: true })
      .select('equipmentPattern equipmentTypes')
      .lean();

    mappings.forEach((m) => {
      const pattern = String(m.equipmentPattern || '').toLowerCase().trim();
      if (!pattern) return;
      if (!normalized.includes(pattern)) return;
      (m.equipmentTypes || []).forEach((t) => {
        if (!t) return;
        result.add(String(t).toLowerCase());
      });
    });
  } catch {
    // ignore
  }

  return result;
}

async function getCertMapForTenant(tenantId) {
  const key = String(tenantId || '');
  if (!key) return new Map();
  const existing = certCacheByTenant.get(key);
  const now = Date.now();
  if (existing && now - existing.ts < 10 * 60 * 1000) return existing.map;
  const map = await buildCertificateCacheForTenant(tenantId);
  certCacheByTenant.set(key, { ts: now, map });
  return map;
}

async function buildSpecialConditionResult(equipmentDoc, tenantId) {
  const equipmentSpecific =
    (equipmentDoc &&
    typeof equipmentDoc === 'object' &&
    equipmentDoc['X condition'] &&
    typeof equipmentDoc['X condition'].Specific === 'string'
      ? equipmentDoc['X condition'].Specific
      : '').trim();

  let text = equipmentSpecific;
  if (!text) {
    const certNo = equipmentDoc?.['Certificate No'] || equipmentDoc?.CertificateNo;
    if (certNo) {
      const certMap = await getCertMapForTenant(tenantId);
      const certificate = resolveCertificateFromCache(certMap, String(certNo));
      text = (certificate?.specCondition || '').trim();
    }
  }
  if (!text) return null;

  return {
    questionId: undefined,
    table: 'SC',
    group: 'SC',
    number: 1,
    equipmentType: 'Special Condition',
    protectionTypes: [],
    status: 'Passed',
    note: '',
    questionText: { eng: text, hun: '' }
  };
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
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You map a failure note to the single most relevant inspection question. ' +
              'Return ONLY a JSON object like {"key":"..."} where key must be one of the provided keys.'
          },
          {
            role: 'user',
            content: JSON.stringify({ failureNote: note, candidates: list })
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        timeout: 60_000
      }
    );

    const txt = String(resp?.data?.choices?.[0]?.message?.content || '').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    const json = m ? JSON.parse(m[0]) : JSON.parse(txt);
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

  const compliance = String(equipmentDoc.Compliance || 'NA');
  if (compliance !== 'Passed' && compliance !== 'Failed') return;

  const inspectionDate = new Date();
  const validUntil = addYears(inspectionDate, 3);

  const inspectionType = 'Detailed';
  const questionDocs = await loadAutoInspectionQuestions(equipmentDoc, tenantId, inspectionType);
  const basePassedTypes = new Set(['general', 'environment', 'additional checks']);
  const relevantTypes = await getRelevantEquipmentTypesForDevice(equipmentDoc, tenantId);
  let results = [];

  if (questionDocs.length) {
    results = questionDocs.map((q) => {
      const eqType = (q.equipmentType || '').toLowerCase();
      const isAlwaysPassed = basePassedTypes.has(eqType);
      const isRelevantByDevice = relevantTypes.has(eqType);
      const shouldBePassed = isAlwaysPassed || isRelevantByDevice;
      return {
        questionId: q._id ? new mongoose.Types.ObjectId(q._id) : undefined,
        table: q.table || q.Table || '',
        group: q.group || q.Group || '',
        number: q.number ?? q.Number ?? null,
        equipmentType: q.equipmentType || '',
        protectionTypes: Array.isArray(q.protectionTypes) ? q.protectionTypes : [],
        status: shouldBePassed ? 'Passed' : 'NA',
        note: '',
        questionText: {
          eng: q.questionText?.eng || '',
          hun: q.questionText?.hun || ''
        }
      };
    });
  }

  if (!results.length) {
    const failureNote = String(failureNoteFromJob || '').trim();
    results = [
      {
        status: compliance,
        note:
          compliance === 'Passed'
            ? 'Automatically created after mobile sync.'
            : failureNote || 'Automatically created after mobile sync (Failed).',
        table: 'AUTO',
        group: 'AUTO',
        number: 1,
        equipmentType: equipmentDoc['Equipment Type'] || '',
        protectionTypes: [],
        questionText: {
          eng: 'Auto-generated inspection after mobile sync.',
          hun: 'Automatikus ellenőrzés mobil szinkron után.'
        }
      }
    ];
  }

  const specialResult = await buildSpecialConditionResult(equipmentDoc, tenantId);
  if (specialResult) results.push(specialResult);

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
    zoneId: equipmentDoc.Zone || null,
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

  for (let i = 0; i < equipmentIds.length; i += 1) {
    const equipmentId = equipmentIds[i];
    try {
      const equipmentDoc = await Equipment.findOne({ _id: equipmentId, tenantId });
      if (!equipmentDoc) {
        await ProcessingJob.updateOne(
          { _id: job._id },
          {
            $push: { errorItems: { equipmentId, message: 'Equipment not found for tenant.' } },
            $set: { processed: i + 1 }
          }
        );
        continue;
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

      // Dataplate reader: OCR -> assistant table -> fill fields (only if empty).
      try {
        await processDataplateForEquipment({ equipmentDoc, tenantKey, userId });
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

      // Auto inspection for mobile-created equipment (Passed or Failed).
      try {
        const failureNoteFromJob = metaByEquipmentId?.[String(equipmentId)]?.failureNote;
        const failureSeverityFromJob = metaByEquipmentId?.[String(equipmentId)]?.failureSeverity;
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

      await ProcessingJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } });
    } catch (err) {
      await ProcessingJob.updateOne(
        { _id: job._id },
        {
          $push: { errorItems: { equipmentId, message: err?.message || String(err) } },
          $set: { processed: i + 1 }
        }
      );
    }
  }
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const job = await ProcessingJob.findOneAndUpdate(
      { type: 'mobileSync', status: 'queued' },
      { $set: { status: 'processing', startedAt: now } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!job) return;

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
  } catch (err) {
    // If we ever fail mid-update, we keep the current job in 'processing' and it can be handled manually.
    // This worker is best-effort and should not crash the server.
  } finally {
    isRunning = false;
  }
}

function start({ intervalMs = 5000 } = {}) {
  setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  // also run soon after boot
  setTimeout(() => tick().catch(() => {}), 1500);
}

module.exports = { start };
