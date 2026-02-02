const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const MaintenanceEvent = require('../models/maintenanceEvent');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function computePendingRepairSet({ tenantObjectId, equipmentIds }) {
  if (!tenantObjectId || !equipmentIds?.length) return new Set();

  // Find latest repair_started per equipment, then check if that repairId has a repair_completed.
  const latestStarts = await MaintenanceEvent.aggregate([
    {
      $match: {
        tenantId: tenantObjectId,
        equipmentId: { $in: equipmentIds },
        kind: 'repair_started'
      }
    },
    { $sort: { occurredAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$equipmentId',
        repairId: { $first: '$repairId' }
      }
    },
    {
      $lookup: {
        from: 'maintenanceevents',
        let: { rid: '$repairId', eq: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', tenantObjectId] },
                  { $eq: ['$equipmentId', '$$eq'] },
                  { $eq: ['$kind', 'repair_completed'] },
                  { $eq: ['$repairId', '$$rid'] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: 'completion'
      }
    },
    {
      $project: {
        _id: 1,
        isPending: { $eq: [{ $size: '$completion' }, 0] }
      }
    }
  ]);

  return new Set(
    (latestStarts || [])
      .filter((x) => x && x.isPending && x._id)
      .map((x) => String(x._id))
  );
}

async function computeOperationalSummary({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const siteObjectId = siteId ? toObjectId(siteId) : null;
  const zoneObjectId = zoneId ? toObjectId(zoneId) : null;
  if (!tenantObjectId) throw new Error('Missing tenantId');
  if (siteId && !siteObjectId) throw new Error('Invalid siteId');
  if (zoneId && !zoneObjectId) throw new Error('Invalid zoneId');

  const eqFilter = { tenantId: tenantObjectId };
  if (siteObjectId) eqFilter.Site = siteObjectId;
  if (zoneObjectId) eqFilter.Zone = zoneObjectId;

  const equipments = await Equipment.find(eqFilter).select('_id operationalStatus').lean();
  const equipmentIds = (equipments || []).map((e) => e._id).filter(Boolean);
  const total = equipmentIds.length;

  if (!total) {
    return {
      total: 0,
      counts: { operating: 0, failed: 0, pending: 0 }
    };
  }

  const pendingSet = await computePendingRepairSet({ tenantObjectId, equipmentIds });

  let failed = 0;
  for (const eq of equipments || []) {
    const id = eq?._id ? String(eq._id) : '';
    if (!id) continue;
    if (pendingSet.has(id)) continue;
    if ((eq.operationalStatus || 'operating') === 'failed') failed += 1;
  }

  const pending = pendingSet.size;
  const operating = Math.max(total - failed - pending, 0);

  return {
    total,
    counts: { operating, failed, pending }
  };
}

async function computeOverallStatusSummary({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const siteObjectId = siteId ? toObjectId(siteId) : null;
  const zoneObjectId = zoneId ? toObjectId(zoneId) : null;
  if (!tenantObjectId) throw new Error('Missing tenantId');
  if (siteId && !siteObjectId) throw new Error('Invalid siteId');
  if (zoneId && !zoneObjectId) throw new Error('Invalid zoneId');

  const eqFilter = { tenantId: tenantObjectId };
  if (siteObjectId) eqFilter.Site = siteObjectId;
  if (zoneObjectId) eqFilter.Zone = zoneObjectId;

  const equipments = await Equipment.find(eqFilter).select('_id operationalStatus Compliance').lean();
  const equipmentIds = (equipments || []).map((e) => e._id).filter(Boolean);
  const total = equipmentIds.length;

  if (!total) {
    return { total: 0, counts: { passedOperating: 0, failed: 0, naPending: 0 } };
  }

  const pendingSet = await computePendingRepairSet({ tenantObjectId, equipmentIds });

  let passedOperating = 0;
  let failed = 0;
  let naPending = 0;

  for (const eq of equipments || []) {
    const id = eq?._id ? String(eq._id) : '';
    if (!id) continue;

    if (pendingSet.has(id)) {
      naPending += 1;
      continue;
    }

    const op = eq.operationalStatus || 'operating';
    const compliance = eq.Compliance || 'NA';

    if (op === 'failed' || compliance === 'Failed') {
      failed += 1;
      continue;
    }

    if (compliance === 'NA') {
      naPending += 1;
      continue;
    }

    // Passed + operating (or anything else treated as OK)
    passedOperating += 1;
  }

  // Safety: clamp
  const accounted = passedOperating + failed + naPending;
  if (accounted !== total) {
    // Prefer not losing items; assign remainder to naPending.
    naPending += Math.max(total - accounted, 0);
  }

  return { total, counts: { passedOperating, failed, naPending } };
}

async function computeMaintenanceSeveritySummary({ tenantId, siteId = null, zoneId = null }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const siteObjectId = siteId ? toObjectId(siteId) : null;
  const zoneObjectId = zoneId ? toObjectId(zoneId) : null;
  if (!tenantObjectId) throw new Error('Missing tenantId');
  if (siteId && !siteObjectId) throw new Error('Invalid siteId');
  if (zoneId && !zoneObjectId) throw new Error('Invalid zoneId');

  const eqFilter = { tenantId: tenantObjectId };
  if (siteObjectId) eqFilter.Site = siteObjectId;
  if (zoneObjectId) eqFilter.Zone = zoneObjectId;

  const equipments = await Equipment.find(eqFilter).select('_id operationalStatus').lean();
  const equipmentIds = (equipments || []).map((e) => e._id).filter(Boolean);
  if (!equipmentIds.length) {
    return {
      totalAffected: 0,
      counts: { P1: 0, P2: 0, P3: 0, P4: 0 }
    };
  }

  const pendingSet = await computePendingRepairSet({ tenantObjectId, equipmentIds });

  const affectedIds = (equipments || [])
    .map((eq) => {
      const id = eq?._id ? String(eq._id) : '';
      if (!id) return null;
      if (pendingSet.has(id)) return id;
      if ((eq.operationalStatus || 'operating') === 'failed') return id;
      return null;
    })
    .filter(Boolean);

  const affectedSet = new Set(affectedIds);
  const totalAffected = affectedSet.size;
  if (!totalAffected) {
    return {
      totalAffected: 0,
      counts: { P1: 0, P2: 0, P3: 0, P4: 0 }
    };
  }

  const latestFaults = await MaintenanceEvent.aggregate([
    {
      $match: {
        tenantId: tenantObjectId,
        equipmentId: { $in: Array.from(affectedSet).map((s) => new mongoose.Types.ObjectId(s)) },
        kind: 'fault_reported'
      }
    },
    { $sort: { occurredAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$equipmentId',
        severity: { $first: '$severity' }
      }
    }
  ]);

  const severityByEquipment = new Map(
    (latestFaults || []).map((x) => [String(x._id), x.severity || null])
  );

  const counts = { P1: 0, P2: 0, P3: 0, P4: 0 };
  for (const id of affectedSet) {
    const sev = severityByEquipment.get(id);
    if (sev === 'P1' || sev === 'P2' || sev === 'P3' || sev === 'P4') {
      counts[sev] += 1;
    }
  }

  return { totalAffected, counts };
}

module.exports = { computeOperationalSummary, computeOverallStatusSummary, computeMaintenanceSeveritySummary };
