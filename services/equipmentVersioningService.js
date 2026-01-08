const mongoose = require('mongoose');
const EquipmentDataVersion = require('../models/equipmentDataVersion');

const IGNORED_TOP_LEVEL_KEYS = new Set([
  '_id',
  '__v',
  'tenantId',
  'CreatedBy',
  'ModifiedBy',
  'createdAt',
  'updatedAt',
  // Mobile sync / async processing internal flags (should not produce user-visible versions)
  'isProcessed',
  'mobileSync',
  'pendingReview',
  'pendingInspectionId',
  'Pictures',
  'documents',
  'lastInspectionDate',
  'lastInspectionValidUntil',
  'lastInspectionStatus',
  'lastInspectionId'
]);

function normalizeScalar(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.getTime();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return value;
}

function isPlainObject(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof mongoose.Types.ObjectId)
  );
}

function sanitizeEquipmentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const result = { ...snapshot };
  for (const key of Object.keys(result)) {
    if (IGNORED_TOP_LEVEL_KEYS.has(key)) {
      delete result[key];
    }
  }
  return result;
}

function deepEqual(a, b) {
  const na = normalizeScalar(a);
  const nb = normalizeScalar(b);

  if (na === nb) return true;
  if (na == null || nb == null) return false;

  if (Array.isArray(na) || Array.isArray(nb)) {
    if (!Array.isArray(na) || !Array.isArray(nb)) return false;
    if (na.length !== nb.length) return false;
    for (let i = 0; i < na.length; i += 1) {
      if (!deepEqual(na[i], nb[i])) return false;
    }
    return true;
  }

  if (isPlainObject(na) || isPlainObject(nb)) {
    if (!isPlainObject(na) || !isPlainObject(nb)) return false;
    const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
    for (const key of keys) {
      if (!deepEqual(na[key], nb[key])) return false;
    }
    return true;
  }

  return false;
}

function computeChangedPaths(oldSnapshot, newSnapshot) {
  const changed = new Set();

  function walk(oldValue, newValue, basePath) {
    const no = normalizeScalar(oldValue);
    const nn = normalizeScalar(newValue);

    if (deepEqual(no, nn)) return;

    if (Array.isArray(no) || Array.isArray(nn)) {
      changed.add(basePath);
      return;
    }

    if (isPlainObject(no) && isPlainObject(nn)) {
      const keys = new Set([...Object.keys(no), ...Object.keys(nn)]);
      for (const key of keys) {
        const nextPath = basePath ? `${basePath}.${key}` : key;
        walk(no[key], nn[key], nextPath);
      }
      return;
    }

    changed.add(basePath);
  }

  const oldClean = sanitizeEquipmentSnapshot(oldSnapshot);
  const newClean = sanitizeEquipmentSnapshot(newSnapshot);
  const topKeys = new Set([...Object.keys(oldClean), ...Object.keys(newClean)]);

  for (const key of topKeys) {
    const path = key;
    walk(oldClean[key], newClean[key], path);
  }

  return Array.from(changed).filter(Boolean).sort();
}

async function createEquipmentDataVersion({
  tenantId,
  equipmentId,
  changedBy,
  changedAt = new Date(),
  source = 'update',
  oldSnapshot,
  newSnapshot,
  ensureBaseline = true
}) {
  const changedPaths = source === 'create' ? [] : computeChangedPaths(oldSnapshot || {}, newSnapshot || {});
  if (!changedPaths.length && source !== 'create') {
    return null;
  }

  const tenantObjectId = typeof tenantId === 'string' ? new mongoose.Types.ObjectId(tenantId) : tenantId;
  const equipmentObjectId =
    typeof equipmentId === 'string' ? new mongoose.Types.ObjectId(equipmentId) : equipmentId;
  const changedByObjectId =
    typeof changedBy === 'string' ? new mongoose.Types.ObjectId(changedBy) : changedBy;

  const latest = await EquipmentDataVersion.findOne({
    tenantId: tenantObjectId,
    equipmentId: equipmentObjectId
  })
    .sort({ version: -1 })
    .select('_id version')
    .lean();

  let previousVersionId = latest?._id || null;
  let nextVersion =
    latest == null
      ? (source === 'create' ? 0 : 0)
      : (latest.version + 1);

  // If the first ever write is an update/import (existing equipment), create a baseline "Creation" version first,
  // so the UI can show "Previously: ..." for the first modification.
  if (!latest && ensureBaseline && source !== 'create') {
    const baselineChangedAtRaw = oldSnapshot?.createdAt || oldSnapshot?.created_at || null;
    const baselineChangedAt =
      baselineChangedAtRaw ? new Date(baselineChangedAtRaw) : (changedAt ? new Date(changedAt) : new Date());

    const baselineChangedByRaw = oldSnapshot?.CreatedBy || oldSnapshot?.createdBy || null;
    const baselineChangedBy =
      typeof baselineChangedByRaw === 'string'
        ? new mongoose.Types.ObjectId(baselineChangedByRaw)
        : (baselineChangedByRaw || changedByObjectId);

    try {
      const baselineDoc = new EquipmentDataVersion({
        tenantId: tenantObjectId,
        equipmentId: equipmentObjectId,
        version: 0,
        changedAt: baselineChangedAt,
        changedBy: baselineChangedBy,
        source: 'create',
        changedPaths: [],
        snapshot: sanitizeEquipmentSnapshot(oldSnapshot || {}),
        previousVersionId: null
      });
      const savedBaseline = await baselineDoc.save();
      previousVersionId = savedBaseline?._id || null;
      nextVersion = 1;
    } catch (err) {
      // If a concurrent request already created the baseline, continue with normal logic.
      if (!(err && err.code === 11000)) {
        throw err;
      }
      const baseline = await EquipmentDataVersion.findOne({
        tenantId: tenantObjectId,
        equipmentId: equipmentObjectId,
        version: 0
      })
        .select('_id')
        .lean();
      previousVersionId = baseline?._id || null;
      nextVersion = 1;
    }
  }

  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    try {
      const doc = new EquipmentDataVersion({
        tenantId: tenantObjectId,
        equipmentId: equipmentObjectId,
        version: nextVersion,
        changedAt,
        changedBy: changedByObjectId,
        source,
        changedPaths,
        snapshot: sanitizeEquipmentSnapshot(newSnapshot || {}),
        previousVersionId
      });
      return await doc.save();
    } catch (err) {
      if (err && err.code === 11000) {
        nextVersion += 1;
        continue;
      }
      throw err;
    }
  }
  return null;
}

module.exports = {
  createEquipmentDataVersion,
  computeChangedPaths,
  sanitizeEquipmentSnapshot
};
