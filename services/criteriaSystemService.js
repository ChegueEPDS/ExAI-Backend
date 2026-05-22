const mongoose = require('mongoose');

const CriteriaSystem = require('../models/criteriaSystem');
const DeviceAssignment = require('../models/deviceCriteriaSystemAssignment');
const Completion = require('../models/criteriaSystemCompletion');
const Finding = require('../models/criteriaSystemFinding');
const QuestionTypeMapping = require('../models/questionTypeMapping');

function toObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function normalizeKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function normalizeCycle(input, fallback = { value: 1, unit: 'year' }) {
  const value = Number(input?.value ?? fallback?.value ?? 1);
  const unit = String(input?.unit || fallback?.unit || 'year');
  return {
    value: Number.isFinite(value) && value > 0 ? Math.floor(value) : 1,
    unit: ['day', 'month', 'year'].includes(unit) ? unit : 'year'
  };
}

function addCycle(date, cycle) {
  if (!date || !cycle?.value) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (cycle.unit === 'day') d.setDate(d.getDate() + cycle.value);
  else if (cycle.unit === 'month') d.setMonth(d.getMonth() + cycle.value);
  else d.setFullYear(d.getFullYear() + cycle.value);
  return d;
}

function sourceDomainFor(system) {
  if (system?.systemKey === 'explosion_safety') return 'explosion_safety';
  return system?.type === 'maintenance' ? 'criteria_maintenance' : 'criteria_compliance';
}

async function ensureExplosionSafetySystem(tenantId, userId = null) {
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) return null;
  const existing = await CriteriaSystem.findOne({ tenantId: tenantObjectId, systemKey: 'explosion_safety' });
  if (existing) {
    let changed = false;
    if (existing.name === 'Robbanásbiztonságtechnika') {
      existing.name = 'Explosion safety';
      changed = true;
    }
    if (existing.active !== false) {
      existing.active = false;
      changed = true;
    }
    if (changed) await existing.save();
    return existing;
  }
  return CriteriaSystem.create({
    tenantId: tenantObjectId,
    name: 'Explosion safety',
    type: 'compliance',
    assignmentScope: 'general',
    equipmentTypes: ['General'],
    cycle: { value: 3, unit: 'year' },
    systemKey: 'explosion_safety',
    isSystemProvided: true,
    active: false,
    createdBy: userId || null,
    updatedBy: userId || null
  });
}

async function getRelevantEquipmentTypes(equipmentDoc, tenantId) {
  const result = new Set(['General']);
  const raw = String(equipmentDoc?.['Equipment Type'] || equipmentDoc?.EquipmentType || '').toLowerCase().trim();
  if (!raw) return result;
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) return result;
  const mappings = await QuestionTypeMapping.find({ tenantId: tenantObjectId, active: true })
    .select('equipmentPattern equipmentTypes')
    .lean();
  for (const m of mappings || []) {
    const pattern = String(m.equipmentPattern || '').toLowerCase().trim();
    if (!pattern || !raw.includes(pattern)) continue;
    (m.equipmentTypes || []).forEach((t) => t && result.add(String(t)));
  }
  return result;
}

function isMappedToEquipment(system, relevantTypes) {
  if (system.assignmentScope === 'general') return true;
  if (system.assignmentScope === 'manual') return false;
  const types = Array.isArray(system.equipmentTypes) ? system.equipmentTypes : [];
  return types.includes('General') || types.some((t) => relevantTypes.has(t));
}

async function loadRelevantSystemsForEquipment({ tenantId, equipment }) {
  await ensureExplosionSafetySystem(tenantId);
  const tenantObjectId = toObjectId(tenantId);
  const systems = await CriteriaSystem.find({ tenantId: tenantObjectId }).sort({ name: 1 }).lean();
  const assignments = await DeviceAssignment.find({
    tenantId: tenantObjectId,
    equipmentId: equipment._id,
    active: true
  }).lean();
  const bySystemId = new Map(assignments.map((a) => [String(a.criteriaSystemId), a]));
  const relevantTypes = await getRelevantEquipmentTypes(equipment, tenantObjectId);

  return systems
    .map((system) => {
      const assignment = bySystemId.get(String(system._id)) || null;
      if (assignment?.state === 'excluded') return null;
      const inherited = system.active !== false && isMappedToEquipment(system, relevantTypes);
      const included = assignment?.state === 'included';
      if (!inherited && !included) return null;
      return {
        system,
        assignment,
        inherited,
        cycle: normalizeCycle(assignment?.cycleOverride, system.cycle)
      };
    })
    .filter(Boolean);
}

async function enrichRelevantSystems({ tenantId, equipment }) {
  const relevant = await loadRelevantSystemsForEquipment({ tenantId, equipment });
  const ids = relevant.map((r) => r.system._id);
  const [lastCompletions, openFindings] = await Promise.all([
    Completion.aggregate([
      { $match: { tenantId: toObjectId(tenantId), equipmentId: equipment._id, criteriaSystemId: { $in: ids } } },
      { $sort: { completedAt: -1, _id: -1 } },
      { $group: { _id: '$criteriaSystemId', doc: { $first: '$$ROOT' } } }
    ]),
    Finding.find({
      tenantId: toObjectId(tenantId),
      equipmentId: equipment._id,
      criteriaSystemId: { $in: ids },
      status: 'open'
    }).lean()
  ]);
  const completionBySystem = new Map(lastCompletions.map((x) => [String(x._id), x.doc]));
  const findingsBySystem = new Map();
  for (const f of openFindings || []) {
    const key = String(f.criteriaSystemId);
    if (!findingsBySystem.has(key)) findingsBySystem.set(key, []);
    findingsBySystem.get(key).push(f);
  }
  return relevant.map((r) => {
    const last = completionBySystem.get(String(r.system._id)) || null;
    const nextDueAt = last?.completedAt ? addCycle(last.completedAt, r.cycle) : null;
    const expired = !!(nextDueAt && nextDueAt.getTime() < Date.now());
    return {
      ...r.system,
      inherited: r.inherited,
      assignment: r.assignment,
      effectiveCycle: r.cycle,
      lastCompletedAt: last?.completedAt || null,
      nextDueAt,
      expired,
      openFindings: findingsBySystem.get(String(r.system._id)) || []
    };
  });
}

async function reconcileEquipmentFindings({ tenantId, equipment, userId = null }) {
  const systems = await enrichRelevantSystems({ tenantId, equipment });
  const now = new Date();
  for (const system of systems) {
    const filter = {
      tenantId: toObjectId(tenantId),
      equipmentId: equipment._id,
      criteriaSystemId: system._id,
      reason: 'expired',
      status: 'open'
    };
    const active = await Finding.findOne(filter);
    if (system.expired && !active) {
      await Finding.create({
        ...filter,
        sourceDomain: sourceDomainFor(system),
        priority: 'P3',
        dueAt: system.nextDueAt,
        reasonText: `${system.name} expired`
      });
    } else if (!system.expired && active) {
      active.status = 'resolved';
      active.resolvedAt = now;
      active.resolvedBy = userId || null;
      active.resolutionReason = 'no_longer_expired';
      await active.save();
    }
  }
  return enrichRelevantSystems({ tenantId, equipment });
}

async function resolveExpiredFinding({ tenantId, equipmentId, criteriaSystemId, userId, completionId }) {
  await Finding.updateMany(
    {
      tenantId: toObjectId(tenantId),
      equipmentId: toObjectId(equipmentId),
      criteriaSystemId: toObjectId(criteriaSystemId),
      reason: 'expired',
      status: 'open'
    },
    {
      $set: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: userId || null,
        completionId: completionId || null,
        resolutionReason: 'completed'
      }
    }
  );
}

module.exports = {
  addCycle,
  ensureExplosionSafetySystem,
  enrichRelevantSystems,
  loadRelevantSystemsForEquipment,
  normalizeCycle,
  normalizeKey,
  reconcileEquipmentFindings,
  resolveExpiredFinding,
  sourceDomainFor,
  toObjectId
};
