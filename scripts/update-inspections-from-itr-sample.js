require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');

const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');
const { scheduleDashboardStatsDirty } = require('../services/dashboardSummaryService');

const DEFAULT_SAMPLE_FILE = '/Users/chegue/Downloads/Vorecon ITRs - Ex h and -46 problems.../80-Voith-IECEx_DEK_11.0081X_Inspection_1780588356136.xlsx';

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if (value.text) return String(value.text);
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

function isMarked(value) {
  return ['x', '✓', '✔', 'true', '1'].includes(String(value || '').trim().toLowerCase());
}

function normalizeRef(value) {
  return String(value || '').trim();
}

function refKey(value) {
  return normalizeRef(value).toUpperCase();
}

function summarize(results) {
  let failedCount = 0;
  let naCount = 0;
  let passedCount = 0;

  for (const result of results || []) {
    if (result.status === 'Failed') failedCount += 1;
    else if (result.status === 'NA') naCount += 1;
    else if (result.status === 'Passed') passedCount += 1;
  }

  return {
    summary: { failedCount, naCount, passedCount },
    status: failedCount > 0 ? 'Failed' : 'Passed'
  };
}

function computeFailureSeverity(results) {
  const rank = { P1: 4, P2: 3, P3: 2, P4: 1 };
  let best = null;
  for (const result of results || []) {
    if (result?.status !== 'Failed') continue;
    const severity = String(result?.severity || '').toUpperCase();
    if (!rank[severity]) continue;
    if (!best || rank[severity] > rank[best]) best = severity;
  }
  return best;
}

async function readTargetsFromSample(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const worksheet = workbook.getWorksheet('Inspection Report') || workbook.worksheets[0];
  if (!worksheet) throw new Error('No worksheet found in sample XLSX');

  const targets = new Map();

  for (let rowIndex = 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const reference = normalizeRef(cellText(row.getCell(1)));
    if (!/^(SC\d+|\d+)$/i.test(reference)) continue;

    const passed = isMarked(cellText(row.getCell(7)));
    const failed = isMarked(cellText(row.getCell(8)));
    const na = isMarked(cellText(row.getCell(9)));
    if (!passed && !failed && !na) continue;

    const commentParts = [];
    for (let col = 10; col <= 14; col += 1) {
      const value = cellText(row.getCell(col)).trim();
      if (value && !commentParts.includes(value)) commentParts.push(value);
    }

    targets.set(refKey(reference), {
      reference,
      status: failed ? 'Failed' : na ? 'NA' : 'Passed',
      note: commentParts.join(' '),
      severity: failed ? null : null
    });
  }

  return targets;
}

async function main() {
  const apply = ['1', 'true'].includes(String(process.env.APPLY || '').toLowerCase());
  const modelType = process.env.MODEL_TYPE || 'EJA430E';
  const sampleFile = process.env.SAMPLE_FILE || DEFAULT_SAMPLE_FILE;
  const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!fs.existsSync(sampleFile)) throw new Error(`Sample file not found: ${sampleFile}`);

  const targets = await readTargetsFromSample(sampleFile);
  if (!targets.size) throw new Error('No target inspection answers were parsed from sample XLSX');

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    maxPoolSize: 10,
    autoIndex: false
  });

  const equipment = await Equipment.find({ 'Model/Type': modelType })
    .select('_id tenantId EqID "Model/Type" lastInspectionId')
    .lean();
  const equipmentIds = equipment.map((item) => item._id);
  const equipmentById = new Map(equipment.map((item) => [String(item._id), item]));
  const tenantIds = Array.from(new Set(equipment.map((item) => String(item.tenantId || '')).filter(Boolean)));

  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    modelType,
    sampleFile,
    targetAnswers: targets.size,
    targetSummary: Array.from(targets.values()).reduce((acc, target) => {
      acc[target.status] = (acc[target.status] || 0) + 1;
      return acc;
    }, {}),
    matchedEquipment: equipment.length,
    tenants: tenantIds
  }, null, 2));

  if (!equipmentIds.length) {
    await mongoose.disconnect();
    return;
  }

  const cursor = Inspection.find({ equipmentId: { $in: equipmentIds } }).cursor();
  const stats = {
    inspected: 0,
    changedInspections: 0,
    changedResults: 0,
    unchangedMatchedResults: 0,
    unmatchedSampleTargets: 0,
    latestEquipmentTouched: 0
  };
  const backupDocs = [];
  let backupPath = null;
  const changedRefs = new Map();
  const missingRefsByInspection = [];

  function appendBackupDoc(doc) {
    if (!apply) return;
    if (!backupPath) {
      fs.mkdirSync(backupDir, { recursive: true });
      const safeModel = modelType.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      backupPath = path.join(
        backupDir,
        `${safeModel}-inspections-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      );
    }
    backupDocs.push(doc);
    fs.writeFileSync(backupPath, JSON.stringify(backupDocs, null, 2));
  }

  for await (const inspection of cursor) {
    stats.inspected += 1;
    let touched = false;
    const seenRefs = new Set();

    for (const result of inspection.results || []) {
      const key = refKey(result.reference || result.number);
      const target = targets.get(key);
      if (!target) continue;
      seenRefs.add(key);

      const nextNote = target.note || '';
      const nextSeverity = target.status === 'Failed' ? target.severity : null;
      const isDifferent =
        result.status !== target.status ||
        (result.note || '') !== nextNote ||
        (result.severity ?? null) !== nextSeverity;

      if (!isDifferent) {
        stats.unchangedMatchedResults += 1;
        continue;
      }

      changedRefs.set(target.reference, (changedRefs.get(target.reference) || 0) + 1);
      result.status = target.status;
      result.note = nextNote;
      result.severity = nextSeverity;
      touched = true;
      stats.changedResults += 1;
    }

    const missingRefs = Array.from(targets.keys()).filter((key) => !seenRefs.has(key));
    if (missingRefs.length) {
      stats.unmatchedSampleTargets += missingRefs.length;
      missingRefsByInspection.push({
        inspectionId: String(inspection._id),
        eqId: inspection.eqId,
        missingRefs: missingRefs.slice(0, 20)
      });
    }

    if (!touched) continue;

    if (apply) {
      appendBackupDoc(inspection.toObject({ depopulate: true }));
    }

    const { summary, status } = summarize(inspection.results || []);
    inspection.summary = summary;
    inspection.status = status;
    inspection.failureSeverity = status === 'Failed' ? computeFailureSeverity(inspection.results || []) : null;
    stats.changedInspections += 1;

    if (apply) {
      await inspection.save();
      const currentEquipment = equipmentById.get(String(inspection.equipmentId));
      if (currentEquipment && String(currentEquipment.lastInspectionId || '') === String(inspection._id)) {
        await Equipment.updateOne(
          { _id: inspection.equipmentId },
          {
            $set: {
              lastInspectionStatus: inspection.status,
              lastInspectionDate: inspection.inspectionDate,
              lastInspectionValidUntil: inspection.validUntil,
              lastInspectionId: inspection._id
            }
          }
        );
        stats.latestEquipmentTouched += 1;
      }
      if (inspection.tenantId) {
        scheduleDashboardStatsDirty({ tenantId: inspection.tenantId, reason: `${modelType}_itr_sample_migration` });
      }
    }
  }

  if (apply && backupPath) {
    console.log(`Backup written: ${backupPath}`);
  }

  console.log(JSON.stringify({
    stats,
    changedRefs: Array.from(changedRefs.entries()).map(([reference, count]) => ({ reference, count })),
    missingRefsByInspection: missingRefsByInspection.slice(0, 10)
  }, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with APPLY=1 to write changes.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
