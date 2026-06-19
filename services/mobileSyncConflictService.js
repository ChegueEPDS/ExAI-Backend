const EquipmentDataVersion = require('../models/equipmentDataVersion');

function isServerNewerThanBase(serverUpdatedAt, baseUpdatedAt) {
  if (!serverUpdatedAt || !baseUpdatedAt) return false;
  const serverTime = new Date(serverUpdatedAt).getTime();
  const baseTime = new Date(baseUpdatedAt).getTime();
  if (!Number.isFinite(serverTime) || !Number.isFinite(baseTime)) return false;
  return serverTime > baseTime;
}

async function hasEquipmentDataVersionAfterBase({ tenantId, equipmentId, baseUpdatedAt }) {
  if (!tenantId || !equipmentId || !baseUpdatedAt) return false;
  const count = await EquipmentDataVersion.countDocuments({
    tenantId,
    equipmentId,
    changedAt: { $gt: baseUpdatedAt }
  }).limit(1);
  return count > 0;
}

async function shouldOpenMobileEquipmentConflict({
  tenantId,
  equipmentId,
  baseUpdatedAt,
  serverUpdatedAt
}) {
  if (!isServerNewerThanBase(serverUpdatedAt, baseUpdatedAt)) return false;

  try {
    return await hasEquipmentDataVersionAfterBase({ tenantId, equipmentId, baseUpdatedAt });
  } catch {
    // Preserve the old conservative behavior if the version lookup fails.
    return true;
  }
}

module.exports = {
  isServerNewerThanBase,
  hasEquipmentDataVersionAfterBase,
  shouldOpenMobileEquipmentConflict
};
