const mongoose = require('mongoose');

const Equipment = require('../models/dataplate');
const MaintenanceEvent = require('../models/maintenanceEvent');
const Inspection = require('../models/inspection');
const EquipmentDataVersion = require('../models/equipmentDataVersion');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function normalizeSeverity(input) {
  const raw = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (raw === 'P1' || raw === 'P2' || raw === 'P3' || raw === 'P4') return raw;
  return null;
}

function parseOptionalDate(input) {
  if (input == null || input === '') return null;
  const raw = String(input).trim();
  const asNum = Number(raw);
  const d = Number.isFinite(asNum) ? new Date(asNum) : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toMillis(value) {
  const d = value instanceof Date ? value : (value ? new Date(value) : null);
  const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  return t;
}

async function loadEquipmentOr404({ tenantId, equipmentId }, res) {
  const eq = await Equipment.findOne({ _id: equipmentId, tenantId });
  if (!eq) {
    res.status(404).json({ error: 'Eszköz nem található.' });
    return null;
  }
  return eq;
}

exports.reportFault = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const equipmentId = toObjectId(req.params.id);
    const actorId = toObjectId(req.scope?.userId);
    if (!tenantId || !equipmentId || !actorId) {
      return res.status(400).json({ error: 'Invalid tenantId / equipmentId / user.' });
    }

    const occurredAt = parseOptionalDate(req.body?.occurredAt) || new Date();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    const severity = normalizeSeverity(req.body?.severity);
    if (!severity) {
      return res.status(400).json({ error: 'Severity is required (P1, P2, P3, P4).' });
    }

    const equipment = await loadEquipmentOr404({ tenantId, equipmentId }, res);
    if (!equipment) return;

    const event = await new MaintenanceEvent({
      tenantId,
      equipmentId,
      kind: 'fault_reported',
      occurredAt,
      actorId,
      note,
      severity
    }).save();

    equipment.operationalStatus = 'failed';
    equipment.operationalStatusChangedAt = occurredAt;
    equipment.operationalStatusChangedBy = actorId;
    equipment.ModifiedBy = actorId;
    await equipment.save();

    return res.status(201).json({ event, operationalStatus: equipment.operationalStatus });
  } catch (error) {
    console.error('❌ reportFault error:', error);
    return res.status(500).json({ error: 'Nem sikerült rögzíteni a meghibásodást.' });
  }
};

exports.startRepair = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const equipmentId = toObjectId(req.params.id);
    const actorId = toObjectId(req.scope?.userId);
    if (!tenantId || !equipmentId || !actorId) {
      return res.status(400).json({ error: 'Invalid tenantId / equipmentId / user.' });
    }

    const occurredAt = parseOptionalDate(req.body?.occurredAt) || new Date();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    const equipment = await loadEquipmentOr404({ tenantId, equipmentId }, res);
    if (!equipment) return;

    const startEvent = new MaintenanceEvent({
      tenantId,
      equipmentId,
      kind: 'repair_started',
      occurredAt,
      actorId,
      note
    });
    startEvent.repairId = startEvent._id;
    await startEvent.save();

    equipment.ModifiedBy = actorId;
    await equipment.save();

    return res.status(201).json({ event: startEvent });
  } catch (error) {
    console.error('❌ startRepair error:', error);
    return res.status(500).json({ error: 'Nem sikerült elindítani a javítást.' });
  }
};

exports.completeRepair = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const equipmentId = toObjectId(req.params.id);
    const actorId = toObjectId(req.scope?.userId);
    const repairId = toObjectId(req.params.repairId);
    if (!tenantId || !equipmentId || !actorId || !repairId) {
      return res.status(400).json({ error: 'Invalid tenantId / equipmentId / user / repairId.' });
    }

    const occurredAt = parseOptionalDate(req.body?.occurredAt) || new Date();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    const completedWorking = req.body?.completedWorking === true;

    const equipment = await loadEquipmentOr404({ tenantId, equipmentId }, res);
    if (!equipment) return;

    const startEvent = await MaintenanceEvent.findOne({
      tenantId,
      equipmentId,
      kind: 'repair_started',
      repairId
    }).lean();
    if (!startEvent) {
      return res.status(404).json({ error: 'Repair indítás nem található.' });
    }

    const alreadyCompleted = await MaintenanceEvent.findOne({
      tenantId,
      equipmentId,
      kind: 'repair_completed',
      repairId
    })
      .select('_id')
      .lean();
    if (alreadyCompleted) {
      return res.status(409).json({ error: 'Ez a javítás már le van zárva.' });
    }

    const completionEvent = await new MaintenanceEvent({
      tenantId,
      equipmentId,
      kind: 'repair_completed',
      occurredAt,
      actorId,
      note,
      repairId,
      completedWorking
    }).save();

    if (completedWorking) {
      equipment.operationalStatus = 'operating';
      equipment.operationalStatusChangedAt = occurredAt;
      equipment.operationalStatusChangedBy = actorId;

      // After maintenance, EX compliance must be treated as non-compliant until a new detailed review/inspection is done.
      // We keep lastInspection* fields intact (audit/history), and use these flags to drive UX reminders.
      equipment.Compliance = 'Failed';
      equipment.pendingReview = true;
      equipment.pendingInspectionId = null;
    }
    equipment.ModifiedBy = actorId;
    await equipment.save();

    return res.status(201).json({
      event: completionEvent,
      operationalStatus: equipment.operationalStatus
    });
  } catch (error) {
    console.error('❌ completeRepair error:', error);
    return res.status(500).json({ error: 'Nem sikerült lezárni a javítást.' });
  }
};

exports.getEquipmentHistory = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    const equipmentId = toObjectId(req.params.id);
    if (!tenantId || !equipmentId) {
      return res.status(400).json({ error: 'Invalid tenantId / equipmentId.' });
    }

    const sortDir = String(req.query.sort || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;

    const equipment = await Equipment.findOne({ _id: equipmentId, tenantId })
      .select('lastInspectionId lastInspectionDate lastInspectionValidUntil lastInspectionStatus')
      .lean();
    if (!equipment) {
      return res.status(404).json({ error: 'Eszköz nem található.' });
    }

    const [maintenanceEvents, inspections, versions] = await Promise.all([
      MaintenanceEvent.find({ tenantId, equipmentId })
        .sort({ occurredAt: -1, _id: -1 })
        .limit(limit)
        .populate('actorId', 'firstName lastName nickname')
        .lean(),
      Inspection.find({ tenantId, equipmentId })
        .sort({ inspectionDate: -1, _id: -1 })
        .limit(limit)
        .populate('inspectorId', 'firstName lastName nickname')
        .lean(),
      EquipmentDataVersion.find({ tenantId, equipmentId })
        .sort({ changedAt: -1, _id: -1 })
        .limit(limit)
        .populate('changedBy', 'firstName lastName nickname')
        .lean()
    ]);

    const events = [];

    for (const e of maintenanceEvents || []) {
      events.push({
        type: 'maintenance',
        occurredAt: e.occurredAt,
        maintenance: {
          ...e,
          actor: e.actorId || null
        }
      });
    }

    for (const i of inspections || []) {
      const sortAt = i.finalizedAt || i.createdAt || i.inspectionDate;
      events.push({
        type: 'inspection',
        occurredAt: i.inspectionDate,
        sortAt,
        inspection: i
      });
    }

    for (const v of versions || []) {
      events.push({
        type: 'dataModification',
        occurredAt: v.changedAt,
        sortAt: v.changedAt,
        version: v
      });
    }

    // Synthetic planned next inspection event (from the latest inspection's validUntil).
    // Show it as a PLANNED item in the same timeline.
    const plannedAt = equipment.lastInspectionValidUntil || null;
    const plannedMillis = toMillis(plannedAt);
    const equipmentLastStatus = equipment.lastInspectionStatus || null;
    if (plannedMillis && equipmentLastStatus === 'Passed') {
      const baseInspId = equipment.lastInspectionId ? equipment.lastInspectionId.toString() : null;
      const baseInspection = baseInspId
        ? (inspections || []).find((x) => x && x._id && x._id.toString() === baseInspId)
        : null;
      if (baseInspection && baseInspection.status && baseInspection.status !== 'Passed') {
        // Safety: equipment summary says Passed, but the inspection doc does not. Don't show PLANNED.
      } else {
      const baseSortMillis = toMillis(baseInspection?.finalizedAt || baseInspection?.createdAt || baseInspection?.inspectionDate);
      const plannedSortAt = baseSortMillis ? new Date(baseSortMillis + 1) : new Date(plannedMillis);

      events.push({
        type: 'inspection_planned',
        occurredAt: new Date(plannedMillis),
        sortAt: plannedSortAt,
        planned: {
          status: 'PLANNED',
          pastDue: Date.now() > plannedMillis,
          basedOnInspectionId: equipment.lastInspectionId || null
        }
      });
      }
    }

    events.sort((a, b) => {
      const ta = toMillis(a?.sortAt || a?.occurredAt);
      const tb = toMillis(b?.sortAt || b?.occurredAt);
      if (ta === tb) return 0;
      return sortDir === 1 ? ta - tb : tb - ta;
    });

    // UX: keep the synthetic PLANNED item always on top.
    const planned = events.filter((e) => e && e.type === 'inspection_planned');
    const rest = events.filter((e) => !e || e.type !== 'inspection_planned');

    return res.json({ items: [...planned, ...rest] });
  } catch (error) {
    console.error('❌ getEquipmentHistory error:', error);
    return res.status(500).json({ error: 'Nem sikerült lekérni a history-t.' });
  }
};
