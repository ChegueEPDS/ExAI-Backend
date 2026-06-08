require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Inspection = require('../models/inspection');

const TARGET_INSPECTION_TYPE = 'Initial Detailed (Index)';
const TARGET_TEXTS = {
  '66': 'Electrical machine protection devices operate within the permitted tE or tA time limits.',
  '67': 'Electrical machine fans have sufficient clearance to the enclosure and/or covers, cooling systems are undamaged, electrical machine foundations have no indentations or cracks.'
};

function isTruthy(value) {
  return ['1', 'true', 'yes', 'apply'].includes(String(value || '').trim().toLowerCase());
}

function normalizeReference(value) {
  return String(value ?? '').trim();
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resultReference(result) {
  const explicit = normalizeReference(result?.reference);
  if (explicit) return explicit;
  if (result?.number !== null && result?.number !== undefined && result?.number !== '') {
    return normalizeReference(result.number);
  }
  return '';
}

function backupPath() {
  const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `inspection-question-texts-${stamp}.jsonl`);
}

async function main() {
  const apply = isTruthy(process.env.APPLY);
  const tenantId = String(process.env.TENANT_ID || process.env.tenantId || '').trim();
  const maxChanges = parsePositiveInt(process.env.MAX_CHANGES);
  const targetRefs = new Set(Object.keys(TARGET_TEXTS));

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required.');
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    maxPoolSize: 10,
    autoIndex: false
  });

  const query = { inspectionType: TARGET_INSPECTION_TYPE };
  if (tenantId) {
    if (!mongoose.isValidObjectId(tenantId)) throw new Error(`Invalid TENANT_ID: ${tenantId}`);
    query.tenantId = new mongoose.Types.ObjectId(tenantId);
  }

  const stats = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    query,
    maxChanges,
    inspected: 0,
    matchedInspections: 0,
    changedInspections: 0,
    changedResults: 0,
    alreadyCorrect: 0,
    missingByRef: Object.fromEntries(Object.keys(TARGET_TEXTS).map(ref => [ref, 0])),
    changedByRef: Object.fromEntries(Object.keys(TARGET_TEXTS).map(ref => [ref, 0])),
    alreadyCorrectByRef: Object.fromEntries(Object.keys(TARGET_TEXTS).map(ref => [ref, 0]))
  };

  const backupFile = apply ? backupPath() : null;
  const cursor = Inspection.find(query).cursor();

  for await (const inspection of cursor) {
    stats.inspected += 1;
    const seenRefs = new Set();
    let changed = false;
    const changes = [];

    for (const result of inspection.results || []) {
      const ref = resultReference(result);
      if (!targetRefs.has(ref)) continue;
      seenRefs.add(ref);
      stats.matchedInspections += 1;

      const nextText = TARGET_TEXTS[ref];
      const currentText = String(result.questionText?.eng || '');
      if (currentText === nextText) {
        stats.alreadyCorrect += 1;
        stats.alreadyCorrectByRef[ref] += 1;
        continue;
      }

      changes.push({
        reference: ref,
        oldText: currentText,
        newText: nextText
      });
      result.questionText = {
        ...(result.questionText || {}),
        eng: nextText
      };
      stats.changedResults += 1;
      stats.changedByRef[ref] += 1;
      changed = true;
    }

    for (const ref of targetRefs) {
      if (!seenRefs.has(ref)) stats.missingByRef[ref] += 1;
    }

    if (!changed) continue;
    stats.changedInspections += 1;

    if (apply) {
      fs.appendFileSync(
        backupFile,
        `${JSON.stringify({
          _id: inspection._id,
          tenantId: inspection.tenantId,
          equipmentId: inspection.equipmentId,
          inspectionType: inspection.inspectionType,
          changes
        })}\n`
      );
      await Inspection.updateOne(
        { _id: inspection._id },
        { $set: { results: inspection.results } },
        { runValidators: false }
      );
      if (maxChanges && stats.changedInspections >= maxChanges) break;
    }
  }

  if (backupFile) stats.backupFile = backupFile;
  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
