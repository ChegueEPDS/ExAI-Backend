const mongoose = require('mongoose');
const SyncTombstone = require('../models/syncTombstone');

function toObjectId(value) {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

async function recordTombstone({ tenantId, entityType, entityId, deletedBy = null, meta = {} }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const entityObjectId = toObjectId(entityId) || entityId;
  const deletedByObjectId = deletedBy ? (toObjectId(deletedBy) || deletedBy) : null;

  if (!tenantObjectId || !entityType || !entityObjectId) {
    throw new Error('recordTombstone: missing tenantId/entityType/entityId');
  }

  await SyncTombstone.updateOne(
    { tenantId: tenantObjectId, entityType, entityId: entityObjectId },
    {
      $setOnInsert: { tenantId: tenantObjectId, entityType, entityId: entityObjectId },
      $set: {
        deletedAt: new Date(),
        deletedBy: deletedByObjectId,
        meta: meta && typeof meta === 'object' ? meta : {}
      }
    },
    { upsert: true }
  );
}

function parseSinceDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const asNum = Number(s);
  const d = Number.isFinite(asNum) ? new Date(asNum) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  recordTombstone,
  parseSinceDate
};

