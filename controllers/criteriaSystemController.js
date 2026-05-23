const mongoose = require('mongoose');

const Equipment = require('../models/dataplate');
const Unit = require('../models/unit');
const CriteriaSystem = require('../models/criteriaSystem');
const DeviceAssignment = require('../models/deviceCriteriaSystemAssignment');
const Completion = require('../models/criteriaSystemCompletion');
const Finding = require('../models/criteriaSystemFinding');
const {
  ensureExplosionSafetySystem,
  enrichRelevantSystems,
  normalizeCycle,
  normalizeKey,
  reconcileEquipmentFindings,
  resolveExpiredFinding,
  sourceDomainFor,
  toObjectId
} = require('../services/criteriaSystemService');

function isSuperAdmin(req) {
  return (req.role || req.user?.role) === 'SuperAdmin';
}

function requireSuperAdmin(req, res) {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ message: 'Only SuperAdmin can manage criteria systems.' });
    return false;
  }
  return true;
}

function tenantIdOr400(req, res) {
  const tenantId = toObjectId(req.scope?.tenantId);
  if (!tenantId) {
    res.status(400).json({ message: 'Invalid or missing tenantId.' });
    return null;
  }
  return tenantId;
}

function parseLimit(raw, fallback = 20, max = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function normalizeScope(scope) {
  const s = String(scope || '').toLowerCase();
  if (s === 'site' || s === 'zone') return s;
  return 'global';
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function dateRangeMatch(field, from, to) {
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return Object.keys(range).length ? { [field]: range } : {};
}

async function buildScopedEquipmentQuery(req, tenantId) {
  const scope = normalizeScope(req.query.scope);
  const siteId = req.query.siteId;
  const zoneId = req.query.zoneId;
  const query = { tenantId, isProcessed: true };

  if (scope === 'site') {
    const siteObjectId = toObjectId(siteId);
    if (!siteObjectId) {
      const err = new Error('Invalid siteId.');
      err.status = 400;
      throw err;
    }
    query.Site = siteObjectId;
  }

  if (scope === 'zone') {
    const siteObjectId = toObjectId(siteId);
    const zoneObjectId = toObjectId(zoneId);
    if (!siteObjectId) {
      const err = new Error('Invalid siteId.');
      err.status = 400;
      throw err;
    }
    if (!zoneObjectId) {
      const err = new Error('Invalid zoneId.');
      err.status = 400;
      throw err;
    }
    query.Site = siteObjectId;
    const unitIds = await Unit.find({
      tenantId,
      $or: [{ _id: zoneObjectId }, { ancestors: zoneObjectId }]
    }).select('_id').lean();
    const ids = unitIds.map((u) => u._id);
    query.$or = [{ Unit: { $in: ids } }, { Zone: { $in: ids } }];
  }

  return {
    scope,
    siteId: scope === 'global' ? null : String(siteId || ''),
    zoneId: scope === 'zone' ? String(zoneId || '') : null,
    query
  };
}

function sanitizeFields(fields) {
  return (Array.isArray(fields) ? fields : []).map((f) => {
    const label = String(f?.label || '').trim();
    const key = normalizeKey(f?.key || label);
    return {
      key,
      label,
      fieldType: ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect'].includes(f?.fieldType)
        ? f.fieldType
        : 'text',
      options: Array.isArray(f?.options) ? f.options.map((x) => String(x || '').trim()).filter(Boolean) : [],
      required: !!f?.required,
      active: f?.active !== false
    };
  }).filter((f) => f.key && f.label);
}

function sanitizeQuestions(questions, existingSystem = null) {
  return (Array.isArray(questions) ? questions : []).map((q, idx) => {
    const prev = q?._id && existingSystem
      ? (existingSystem.questions || []).find((x) => String(x._id) === String(q._id))
      : null;
    const origin = prev?.origin === 'global_system' ? 'global_system' : 'tenant_additional';
    return {
      _id: q?._id && mongoose.Types.ObjectId.isValid(String(q._id)) ? q._id : undefined,
      text: String(q?.text || '').trim(),
      origin,
      order: Number.isFinite(Number(q?.order)) ? Number(q.order) : idx + 1,
      active: q?.active !== false
    };
  }).filter((q) => q.text);
}

exports.list = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    await ensureExplosionSafetySystem(tenantId, req.userId || null);
    const query = { tenantId };
    if (String(req.query.includeInactive || '').toLowerCase() !== 'true') query.active = true;
    const items = await CriteriaSystem.find(query).sort({ isSystemProvided: -1, name: 1 }).lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to list criteria systems.' });
  }
};

exports.statistics = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    await ensureExplosionSafetySystem(tenantId, req.userId || null);

    const systems = await CriteriaSystem.find({ tenantId, active: { $ne: false } })
      .sort({ isSystemProvided: -1, name: 1 })
      .lean();
    const ids = systems.map((s) => s._id);
    const scoped = await buildScopedEquipmentQuery(req, tenantId);
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    let scopedEquipmentIds = null;
    if (scoped.scope !== 'global') {
      const rows = await Equipment.find(scoped.query).select('_id').lean();
      scopedEquipmentIds = rows.map((eq) => eq._id);
    }
    const scopedMatch = scopedEquipmentIds ? { equipmentId: { $in: scopedEquipmentIds } } : {};

    const [assignments, completions, openFindings, overdueFindings, startedFindings] = await Promise.all([
      DeviceAssignment.aggregate([
        { $match: { tenantId, criteriaSystemId: { $in: ids }, state: 'included', active: { $ne: false }, ...scopedMatch } },
        { $group: { _id: '$criteriaSystemId', count: { $sum: 1 } } }
      ]),
      Completion.aggregate([
        { $match: { tenantId, criteriaSystemId: { $in: ids }, ...scopedMatch, ...dateRangeMatch('completedAt', from, to) } },
        { $group: { _id: '$criteriaSystemId', count: { $sum: 1 }, lastCompletedAt: { $max: '$completedAt' } } }
      ]),
      Finding.aggregate([
        { $match: { tenantId, criteriaSystemId: { $in: ids }, status: 'open', ...scopedMatch } },
        { $group: { _id: '$criteriaSystemId', count: { $sum: 1 } } }
      ]),
      Finding.aggregate([
        { $match: { tenantId, criteriaSystemId: { $in: ids }, status: 'open', dueAt: { $lt: new Date() }, ...scopedMatch } },
        { $group: { _id: '$criteriaSystemId', count: { $sum: 1 } } }
      ]),
      Finding.aggregate([
        { $match: { tenantId, criteriaSystemId: { $in: ids }, ...scopedMatch, ...dateRangeMatch('createdAt', from, to) } },
        { $group: { _id: '$criteriaSystemId', count: { $sum: 1 } } }
      ])
    ]);

    const byId = (rows) => new Map((rows || []).map((r) => [String(r._id), r]));
    const assignmentById = byId(assignments);
    const completionById = byId(completions);
    const openById = byId(openFindings);
    const overdueById = byId(overdueFindings);
    const startedById = byId(startedFindings);

    const items = systems.map((s) => {
      const id = String(s._id);
      const c = completionById.get(id) || {};
      return {
        criteriaSystemId: id,
        name: s.name,
        type: s.type,
        assignmentScope: s.assignmentScope,
        assignedEquipmentCount: Number(assignmentById.get(id)?.count || 0),
        startedFindingCount: Number(startedById.get(id)?.count || 0),
        completionCount: Number(c.count || 0),
        openFindingCount: Number(openById.get(id)?.count || 0),
        overdueFindingCount: Number(overdueById.get(id)?.count || 0),
        lastCompletedAt: c.lastCompletedAt || null
      };
    });

    res.json({
      scope: { scope: scoped.scope, siteId: scoped.siteId, zoneId: scoped.zoneId },
      items
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load criteria statistics.' });
  }
};

exports.attention = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    await ensureExplosionSafetySystem(tenantId, req.userId || null);

    const limit = parseLimit(req.query.limit, 20, 50);
    const scoped = await buildScopedEquipmentQuery(req, tenantId);
    let scopedEquipmentIds = null;
    if (scoped.scope !== 'global') {
      const rows = await Equipment.find(scoped.query).select('_id').lean();
      scopedEquipmentIds = rows.map((eq) => eq._id);
    }

    const findingQuery = {
        tenantId,
        status: 'open',
        dueAt: { $ne: null, $lt: new Date() }
    };
    if (scopedEquipmentIds) findingQuery.equipmentId = { $in: scopedEquipmentIds };

    const findings = !scopedEquipmentIds || scopedEquipmentIds.length
      ? await Finding.find(findingQuery)
          .select('_id equipmentId criteriaSystemId reason status priority dueAt reasonText sourceDomain createdAt')
          .sort({ dueAt: 1, createdAt: 1, _id: 1 })
          .limit(limit)
          .lean()
      : [];

    const equipmentIds = [...new Set(findings.map((f) => String(f.equipmentId)).filter(Boolean))];
    const equipmentRows = equipmentIds.length
      ? await Equipment.find({ tenantId, _id: { $in: equipmentIds } })
          .select('_id EqID TagNo Site Unit Zone')
          .populate({ path: 'Site', select: 'Name', options: { lean: true } })
          .populate({ path: 'Unit', select: 'Name', options: { lean: true } })
          .populate({ path: 'Zone', select: 'Name', options: { lean: true } })
          .lean()
      : [];
    const equipmentById = new Map((equipmentRows || []).map((eq) => [String(eq._id), eq]));

    const systemIds = [...new Set(findings.map((f) => String(f.criteriaSystemId)).filter(Boolean))];
    const systems = systemIds.length
      ? await CriteriaSystem.find({ tenantId, _id: { $in: systemIds } })
        .select('_id name type assignmentScope')
        .lean()
      : [];
    const systemsById = new Map((systems || []).map((s) => [String(s._id), s]));

    const items = findings.map((f) => {
      const eq = equipmentById.get(String(f.equipmentId)) || {};
      const system = systemsById.get(String(f.criteriaSystemId)) || {};
      return {
        findingId: String(f._id),
        criteriaSystemId: String(f.criteriaSystemId),
        criteriaSystemName: system.name || 'Criteria system',
        criteriaSystemType: system.type || null,
        equipmentId: String(f.equipmentId),
        eqId: eq.EqID || null,
        tagNo: eq.TagNo || null,
        priority: f.priority || null,
        reason: f.reason || null,
        reasonText: f.reasonText || '',
        dueAt: f.dueAt || null,
        siteName: eq.Site?.Name || null,
        zoneName: eq.Unit?.Name || eq.Zone?.Name || null
      };
    });

    res.json({
      scope: { scope: scoped.scope, siteId: scoped.siteId, zoneId: scoped.zoneId },
      limit,
      items
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Failed to load criteria attention.' });
  }
};

exports.create = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required.' });
    const type = body.type === 'maintenance' ? 'maintenance' : 'compliance';
    const assignmentScope = ['general', 'device_type', 'manual'].includes(body.assignmentScope)
      ? body.assignmentScope
      : 'manual';
    const created = await CriteriaSystem.create({
      tenantId,
      name,
      type,
      assignmentScope,
      equipmentTypes: assignmentScope === 'device_type' ? (Array.isArray(body.equipmentTypes) ? body.equipmentTypes : []) : [],
      cycle: normalizeCycle(body.cycle),
      active: body.active !== false,
      customFields: sanitizeFields(body.customFields),
      questions: type === 'compliance' ? sanitizeQuestions(body.questions) : [],
      createdBy: req.userId || null,
      updatedBy: req.userId || null
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create criteria system.' });
  }
};

exports.update = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const system = await CriteriaSystem.findOne({ _id: req.params.id, tenantId });
    if (!system) return res.status(404).json({ message: 'Criteria system not found.' });
    const body = req.body || {};

    if (body.name !== undefined && !system.isSystemProvided) {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ message: 'name cannot be empty.' });
      system.name = name;
    }
    if (!system.isSystemProvided && body.type !== undefined) {
      system.type = body.type === 'maintenance' ? 'maintenance' : 'compliance';
    }
    if (body.assignmentScope !== undefined) {
      system.assignmentScope = ['general', 'device_type', 'manual'].includes(body.assignmentScope) ? body.assignmentScope : system.assignmentScope;
    }
    if (body.equipmentTypes !== undefined) system.equipmentTypes = Array.isArray(body.equipmentTypes) ? body.equipmentTypes : [];
    if (body.cycle !== undefined) system.cycle = normalizeCycle(body.cycle, system.cycle);
    if (body.active !== undefined) {
      system.active = !!body.active;
      if (!system.active) {
        await Finding.updateMany(
          { tenantId, criteriaSystemId: system._id, status: 'open' },
          { $set: { status: 'archived_due_to_inactive', resolvedAt: new Date(), resolvedBy: req.userId || null } }
        );
      }
    }
    if (!system.isSystemProvided && body.customFields !== undefined) system.customFields = sanitizeFields(body.customFields);
    if (body.questions !== undefined) system.questions = sanitizeQuestions(body.questions, system);
    system.updatedBy = req.userId || null;
    await system.save();
    res.json(system);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update criteria system.' });
  }
};

exports.getEquipmentSystems = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    const equipmentId = toObjectId(req.params.equipmentId);
    if (!tenantId || !equipmentId) return res.status(400).json({ message: 'Invalid equipment id.' });
    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    if (!equipment) return res.status(404).json({ message: 'Equipment not found.' });
    const items = await reconcileEquipmentFindings({ tenantId, equipment, userId: req.userId || null });
    const assignments = await DeviceAssignment.find({ tenantId, equipmentId }).lean();
    const availableSystems = isSuperAdmin(req)
      ? await CriteriaSystem.find({ tenantId }).sort({ name: 1 }).lean()
      : [];
    res.json({ items, assignments, availableSystems });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load equipment criteria systems.' });
  }
};

exports.saveAssignment = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const tenantId = tenantIdOr400(req, res);
    const equipmentId = toObjectId(req.params.equipmentId);
    const criteriaSystemId = toObjectId(req.params.criteriaSystemId);
    if (!tenantId || !equipmentId || !criteriaSystemId) return res.status(400).json({ message: 'Invalid id.' });
    const state = req.body?.state === 'excluded' ? 'excluded' : 'included';
    const payload = {
      tenantId,
      equipmentId,
      criteriaSystemId,
      state,
      active: req.body?.active !== false,
      cycleOverride: req.body?.cycleOverride ? normalizeCycle(req.body.cycleOverride) : null,
      startDate: req.body?.startDate ? new Date(req.body.startDate) : null,
      updatedBy: req.userId || null
    };
    const assignment = await DeviceAssignment.findOneAndUpdate(
      { tenantId, equipmentId, criteriaSystemId },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (state === 'excluded') {
      await Finding.updateMany(
        { tenantId, equipmentId, criteriaSystemId, status: 'open' },
        { $set: { status: 'archived_due_to_assignment_excluded', resolvedAt: new Date(), resolvedBy: req.userId || null } }
      );
    }
    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    const items = equipment ? await reconcileEquipmentFindings({ tenantId, equipment, userId: req.userId || null }) : [];
    res.json({ assignment, items });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to save assignment.' });
  }
};

exports.recordCompletion = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    const equipmentId = toObjectId(req.params.equipmentId);
    const criteriaSystemId = toObjectId(req.params.criteriaSystemId);
    const userId = toObjectId(req.userId || req.scope?.userId);
    if (!tenantId || !equipmentId || !criteriaSystemId || !userId) return res.status(400).json({ message: 'Invalid request.' });
    const system = await CriteriaSystem.findOne({ _id: criteriaSystemId, tenantId, active: true });
    if (!system) return res.status(404).json({ message: 'Criteria system not found.' });
    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    if (!equipment) return res.status(404).json({ message: 'Equipment not found.' });
    if (req.body?.completed !== true) return res.status(400).json({ message: 'completed must be true.' });
    const completion = await Completion.create({
      tenantId,
      equipmentId,
      criteriaSystemId,
      completedAt: req.body?.completedAt ? new Date(req.body.completedAt) : new Date(),
      note: String(req.body?.note || '').trim(),
      completedByUserId: userId,
      source: system.type === 'maintenance' ? 'maintenance' : 'inspection',
      inspectionId: toObjectId(req.body?.inspectionId)
    });
    await resolveExpiredFinding({ tenantId, equipmentId, criteriaSystemId, userId, completionId: completion._id });
    const items = await reconcileEquipmentFindings({ tenantId, equipment, userId });
    res.status(201).json({ completion, items });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to record completion.' });
  }
};

exports.listComplianceForEquipment = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    const equipmentId = toObjectId(req.params.equipmentId);
    if (!tenantId || !equipmentId) return res.status(400).json({ message: 'Invalid equipment id.' });
    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
    if (!equipment) return res.status(404).json({ message: 'Equipment not found.' });
    const items = (await enrichRelevantSystems({ tenantId, equipment }))
      .filter((x) => x.active !== false && x.type === 'compliance')
      .map((x) => ({ ...x, sourceDomain: sourceDomainFor(x) }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to list compliance criteria.' });
  }
};
