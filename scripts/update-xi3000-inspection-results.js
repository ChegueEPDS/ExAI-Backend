require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const { scheduleDashboardStatsDirty } = require('../services/dashboardSummaryService');

const DEFAULT_EQUIPMENT_FILE = '/Users/chegue/Downloads/Model:Type- Xi 3000.json';
const DEFAULT_ORIGINAL_FILE = '/Users/chegue/Downloads/original.json';
const DEFAULT_NEW_FILE = '/Users/chegue/Downloads/new.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function oid(value) {
  if (!value) return null;
  const raw = typeof value === 'object' && value.$oid ? value.$oid : value;
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function resultKey(result) {
  const qid = result?.questionId ? String(result.questionId.$oid || result.questionId) : '';
  if (qid) return `qid:${qid}`;
  const reference = result?.reference ? String(result.reference) : '';
  if (reference) return `ref:${reference}`;
  return `num:${result?.number ?? ''}`;
}

function summarize(results) {
  let failedCount = 0;
  let naCount = 0;
  let passedCount = 0;

  for (const r of results || []) {
    if (r.status === 'Failed') failedCount += 1;
    else if (r.status === 'NA') naCount += 1;
    else if (r.status === 'Passed') passedCount += 1;
  }

  return {
    summary: { failedCount, naCount, passedCount },
    status: failedCount > 0 ? 'Failed' : 'Passed'
  };
}

function computeFailureSeverity(results) {
  const rank = { P1: 4, P2: 3, P3: 2, P4: 1 };
  let best = null;
  for (const r of results || []) {
    if (r?.status !== 'Failed') continue;
    const sev = String(r?.severity || '').toUpperCase();
    if (!rank[sev]) continue;
    if (!best || rank[sev] > rank[best]) best = sev;
  }
  return best;
}

function changedPatch(originalInspection, newInspection) {
  const originalByKey = new Map((originalInspection.results || []).map((r) => [resultKey(r), r]));
  const patches = [];

  for (const next of newInspection.results || []) {
    const key = resultKey(next);
    const prev = originalByKey.get(key);
    if (!prev) continue;

    const patch = {
      key,
      questionId: next.questionId ? String(next.questionId.$oid || next.questionId) : '',
      reference: next.reference ? String(next.reference) : '',
      number: next.number,
      original: {
        status: prev.status,
        note: prev.note || '',
        severity: prev.severity ?? null
      },
      next: {
        status: next.status,
        note: next.note || '',
        severity: next.severity ?? null
      }
    };

    const isChanged =
      !sameValue(patch.original.status, patch.next.status) ||
      !sameValue(patch.original.note, patch.next.note) ||
      !sameValue(patch.original.severity, patch.next.severity);

    if (isChanged) patches.push(patch);
  }

  return patches;
}

function matchesOriginal(current, patch) {
  return (
    sameValue(current.status, patch.original.status) &&
    sameValue(current.note || '', patch.original.note || '') &&
    sameValue(current.severity ?? null, patch.original.severity ?? null)
  );
}

async function main() {
  const equipmentFile = process.env.EQUIPMENT_FILE || DEFAULT_EQUIPMENT_FILE;
  const originalFile = process.env.ORIGINAL_FILE || DEFAULT_ORIGINAL_FILE;
  const newFile = process.env.NEW_FILE || DEFAULT_NEW_FILE;
  const apply = String(process.env.APPLY || '').toLowerCase() === '1' || String(process.env.APPLY || '').toLowerCase() === 'true';
  const force = String(process.env.FORCE || '').toLowerCase() === '1' || String(process.env.FORCE || '').toLowerCase() === 'true';
  const modelType = process.env.MODEL_TYPE || 'Xi 3000';
  const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

  const exportedEquipment = readJson(equipmentFile);
  const originalInspection = Array.isArray(readJson(originalFile)) ? readJson(originalFile)[0] : readJson(originalFile);
  const newInspection = Array.isArray(readJson(newFile)) ? readJson(newFile)[0] : readJson(newFile);
  const patches = changedPatch(originalInspection, newInspection);

  const exportedIds = new Set((exportedEquipment || []).map((e) => String(e?._id?.$oid || e?._id || '')).filter(Boolean));
  const tenantIds = Array.from(new Set((exportedEquipment || []).map((e) => String(e?.tenantId?.$oid || e?.tenantId || '')).filter(Boolean)));

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    maxPoolSize: 10,
    autoIndex: false
  });

  const equipmentFilter = {
    _id: { $in: Array.from(exportedIds).map((id) => oid(id)).filter(Boolean) },
    'Model/Type': modelType
  };
  if (tenantIds.length === 1 && oid(tenantIds[0])) equipmentFilter.tenantId = oid(tenantIds[0]);

  const equipmentIds = await Equipment.find(equipmentFilter).select('_id tenantId EqID "Model/Type"').lean();
  const ids = equipmentIds.map((e) => e._id);
  const tenantSet = new Set(equipmentIds.map((e) => String(e.tenantId || '')).filter(Boolean));

  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    force,
    modelType,
    exportedEquipment: exportedIds.size,
    matchedEquipment: ids.length,
    tenants: Array.from(tenantSet),
    changedQuestions: patches.map((p) => ({
      questionId: p.questionId,
      reference: p.reference,
      number: p.number,
      from: p.original,
      to: p.next
    }))
  }, null, 2));

  if (!ids.length || !patches.length) {
    await mongoose.disconnect();
    return;
  }

  const cursor = Inspection.find({ equipmentId: { $in: ids } }).cursor();
  const stats = {
    inspected: 0,
    changedInspections: 0,
    changedResults: 0,
    skippedResults: 0
  };
  const backupDocs = [];

  for await (const inspection of cursor) {
    stats.inspected += 1;
    let touched = false;

    for (const result of inspection.results || []) {
      const key = resultKey(result);
      const patch = patches.find((p) => p.key === key);
      if (!patch) continue;

      if (!force && !matchesOriginal(result, patch)) {
        stats.skippedResults += 1;
        continue;
      }

      result.status = patch.next.status;
      result.note = patch.next.note;
      result.severity = patch.next.severity;
      touched = true;
      stats.changedResults += 1;
    }

    if (!touched) continue;

    if (apply) {
      backupDocs.push(inspection.toObject({ depopulate: true }));
    }

    const { summary, status } = summarize(inspection.results || []);
    inspection.summary = summary;
    inspection.status = status;
    inspection.failureSeverity = status === 'Failed' ? computeFailureSeverity(inspection.results || []) : null;
    stats.changedInspections += 1;

    if (apply) {
      await inspection.save();
      if (inspection.tenantId) {
        scheduleDashboardStatsDirty({ tenantId: inspection.tenantId, reason: 'xi3000_inspection_results_migration' });
      }
    }
  }

  if (apply && backupDocs.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(
      backupDir,
      `xi3000-inspections-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(backupDocs, null, 2));
    console.log(`Backup written: ${backupPath}`);
  }

  console.log(JSON.stringify(stats, null, 2));
  if (!apply) {
    console.log('Dry run only. Re-run with APPLY=1 to write changes. Use FORCE=1 only if existing answers should be overwritten even when they differ from original.json.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
