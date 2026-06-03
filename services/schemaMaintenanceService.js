const mongoose = require('mongoose');
const SchemaDefinition = require('../models/schemaDefinition');
const Inspection = require('../models/inspection');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function loadSchemasByType(tenantId, type) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  return SchemaDefinition.find({
    type,
    status: 'published',
    active: { $ne: false },
    systemKey: { $ne: 'rb' },
    $or: [
      { scope: 'system' },
      { scope: 'tenant', tenantId: tenantObjectId }
    ]
  }).select('_id systemKey name').lean();
}

async function loadMaintenanceSchemas(tenantId) {
  return loadSchemasByType(tenantId, 'maintenance');
}

async function loadComplianceSchemas(tenantId) {
  return loadSchemasByType(tenantId, 'compliance');
}

function schemaIdSets(schemas) {
  return {
    ids: new Set((schemas || []).map((schema) => String(schema._id)).filter(Boolean)),
    keys: new Set((schemas || []).map((schema) => schema.systemKey).filter(Boolean))
  };
}

function maintenanceSchemaIdSets(schemas) {
  return schemaIdSets(schemas);
}

function isMaintenanceAssignment(assignment, sets) {
  if (!assignment || !sets) return false;
  const id = assignment.schemaId ? String(assignment.schemaId) : '';
  const key = assignment.schemaKey ? String(assignment.schemaKey) : '';
  return (!!id && sets.ids.has(id)) || (!!key && sets.keys.has(key));
}

function isSchemaAssignment(assignment, sets) {
  return isMaintenanceAssignment(assignment, sets);
}

function assignmentStatus(values = {}, nowMs = Date.now()) {
  if (!values.lastInspectionDate || values.lastInspectionStatus === 'Failed') return 'failed';
  const nextMs = values.nextInspectionDate ? new Date(values.nextInspectionDate).getTime() : null;
  if (nextMs && Number.isFinite(nextMs) && nowMs > nextMs) return 'pending';
  return 'operating';
}

async function computeMaintenanceSchemaStatusSummary({ tenantId, equipments }) {
  return computeSchemaStatusSummary({ tenantId, equipments, type: 'maintenance' });
}

async function computeComplianceSchemaStatusSummary({ tenantId, equipments }) {
  return computeSchemaStatusSummary({ tenantId, equipments, type: 'compliance' });
}

async function computeSchemaStatusSummary({ tenantId, equipments, type }) {
  const schemas = await loadSchemasByType(tenantId, type);
  const sets = schemaIdSets(schemas);
  const byId = new Map((schemas || []).map((schema) => [String(schema._id), schema]));
  const byKey = new Map((schemas || []).filter((schema) => schema.systemKey).map((schema) => [String(schema.systemKey), schema]));
  const bySchema = new Map();
  const counts = type === 'maintenance'
    ? { operating: 0, failed: 0, pending: 0 }
    : { passed: 0, failed: 0, na: 0 };
  const nowMs = Date.now();

  for (const equipment of equipments || []) {
    for (const assignment of equipment.schemaAssignments || []) {
      if (!isSchemaAssignment(assignment, sets)) continue;
      const schema = assignment.schemaId
        ? byId.get(String(assignment.schemaId))
        : byKey.get(String(assignment.schemaKey || ''));
      const schemaId = schema?._id ? String(schema._id) : String(assignment.schemaId || assignment.schemaKey || '');
      if (!schemaId) continue;
      if (!bySchema.has(schemaId)) {
        bySchema.set(schemaId, {
          schemaId,
          name: schema?.name || assignment.schemaKey || (type === 'maintenance' ? 'Maintenance schema' : 'Compliance schema'),
          total: 0,
          counts: type === 'maintenance'
            ? { operating: 0, failed: 0, pending: 0 }
            : { passed: 0, failed: 0, na: 0 }
        });
      }
      const status = assignmentStatus(assignment.values || {}, nowMs);
      const key = type === 'maintenance'
        ? status
        : status === 'operating'
          ? 'passed'
          : status === 'pending'
            ? 'na'
            : 'failed';
      counts[key] += 1;
      const item = bySchema.get(schemaId);
      item.counts[key] += 1;
      item.total += 1;
    }
  }

  return {
    total: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
    counts,
    bySchema: Array.from(bySchema.values()).sort((a, b) => a.name.localeCompare(b.name))
  };
}

async function buildMaintenanceSchemaIncidents({ tenantId, equipmentIds }) {
  return buildSchemaIncidents({ tenantId, equipmentIds, type: 'maintenance' });
}

async function buildComplianceSchemaIncidents({ tenantId, equipmentIds }) {
  return buildSchemaIncidents({ tenantId, equipmentIds, type: 'compliance' });
}

async function buildSchemaIncidents({ tenantId, equipmentIds, type }) {
  const tenantObjectId = toObjectId(tenantId) || tenantId;
  const ids = (equipmentIds || []).filter(Boolean);
  if (!ids.length) return [];

  const schemas = await loadSchemasByType(tenantObjectId, type);
  const schemaIds = schemas.map((schema) => schema._id);
  const schemaById = new Map(schemas.map((schema) => [String(schema._id), schema]));

  const inspections = await Inspection.find({
    tenantId: tenantObjectId,
    equipmentId: { $in: ids },
    reviewStatus: { $ne: 'pending' },
    $or: [
      { schemaTypeSnapshot: type, schemaId: { $in: schemaIds } },
      { schemaId: { $in: schemaIds } }
    ]
  })
    .select('equipmentId schemaId status failureSeverity finalizedAt createdAt inspectionDate')
    .sort({ equipmentId: 1, schemaId: 1, finalizedAt: 1, createdAt: 1, inspectionDate: 1, _id: 1 })
    .lean();

  const incidents = [];
  let currentKey = null;
  let active = false;
  let startedMs = null;
  let severity = null;

  function timeOf(insp) {
    const raw = insp.finalizedAt || insp.createdAt || insp.inspectionDate;
    const d = raw ? new Date(raw) : null;
    const t = d && Number.isFinite(d.getTime()) ? d.getTime() : null;
    return t;
  }

  function flush() {
    if (active && startedMs != null) {
      const [equipmentId, schemaId] = String(currentKey || '').split(':');
      const schema = schemaById.get(schemaId);
      incidents.push({ equipmentId, schemaId, schemaName: schema?.name || (type === 'maintenance' ? 'Maintenance schema' : 'Compliance schema'), startMs: startedMs, endMs: null, repairs: 0, severity });
    }
    active = false;
    startedMs = null;
    severity = null;
  }

  for (const insp of inspections || []) {
    const equipmentId = insp.equipmentId ? String(insp.equipmentId) : '';
    const schemaId = insp.schemaId ? String(insp.schemaId) : '';
    if (!equipmentId || !schemaId) continue;
    const key = `${equipmentId}:${schemaId}`;
    if (currentKey == null) currentKey = key;
    if (key !== currentKey) {
      flush();
      currentKey = key;
    }

    const t = timeOf(insp);
    if (!t) continue;

    if (insp.status === 'Failed') {
      if (!active) {
        active = true;
        startedMs = t;
        severity = insp.failureSeverity || null;
      } else if (!severity && insp.failureSeverity) {
        severity = insp.failureSeverity;
      }
      continue;
    }

    if (insp.status === 'Passed' && active && startedMs != null && t >= startedMs) {
      const schema = schemaById.get(schemaId);
      incidents.push({ equipmentId, schemaId, schemaName: schema?.name || (type === 'maintenance' ? 'Maintenance schema' : 'Compliance schema'), startMs: startedMs, endMs: t, repairs: 0, severity });
      active = false;
      startedMs = null;
      severity = null;
    }
  }

  flush();
  return incidents;
}

module.exports = {
  buildComplianceSchemaIncidents,
  buildMaintenanceSchemaIncidents,
  computeComplianceSchemaStatusSummary,
  computeMaintenanceSchemaStatusSummary,
  loadComplianceSchemas,
  loadMaintenanceSchemas,
  maintenanceSchemaIdSets,
  isMaintenanceAssignment,
  isSchemaAssignment,
  assignmentStatus
};
