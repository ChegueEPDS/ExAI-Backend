const CYCLE_UNITS = ['day', 'month', 'year'];
const CYCLE_FIELD_KEYS = new Set(['cycleValue', 'cycleUnit', 'startDate', 'cyclevalue', 'cycleunit', 'startdate']);

function normalizeCycleValue(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeCycleUnit(value, fallback = 'year') {
  const unit = String(value || '').trim().toLowerCase();
  return CYCLE_UNITS.includes(unit) ? unit : fallback;
}

function schemaDefaultCycle(schema) {
  if (schema?.systemKey === 'rb') {
    return { value: 3, unit: 'year' };
  }
  return {
    value: normalizeCycleValue(schema?.defaultCycleValue, 1),
    unit: normalizeCycleUnit(schema?.defaultCycleUnit, 'year')
  };
}

function addCycle(date, value, unit) {
  const base = date instanceof Date ? new Date(date) : new Date(date);
  if (!Number.isFinite(base.getTime())) return null;

  const out = new Date(base);
  const amount = normalizeCycleValue(value, 1);
  const normalizedUnit = normalizeCycleUnit(unit, 'year');
  if (normalizedUnit === 'day') out.setDate(out.getDate() + amount);
  if (normalizedUnit === 'month') out.setMonth(out.getMonth() + amount);
  if (normalizedUnit === 'year') out.setFullYear(out.getFullYear() + amount);
  return out;
}

function stripCycleDataFields(fields = []) {
  return (Array.isArray(fields) ? fields : []).filter((field) => !CYCLE_FIELD_KEYS.has(field?.key));
}

function applySchemaCycleDefaults(schema, values = {}) {
  const out = { ...(values || {}) };
  delete out.startDate;

  const defaults = schemaDefaultCycle(schema);
  if (schema?.systemKey === 'rb') {
    out.cycleValue = 3;
    out.cycleUnit = 'year';
    return out;
  }

  out.cycleValue = normalizeCycleValue(out.cycleValue, defaults.value);
  out.cycleUnit = normalizeCycleUnit(out.cycleUnit, defaults.unit);
  return out;
}

function assignmentCycle(assignment, schema) {
  const defaults = schemaDefaultCycle(schema);
  const values = assignment?.values || {};
  if (schema?.systemKey === 'rb' || assignment?.schemaKey === 'rb') {
    return { value: 3, unit: 'year' };
  }
  return {
    value: normalizeCycleValue(values.cycleValue, defaults.value),
    unit: normalizeCycleUnit(values.cycleUnit, defaults.unit)
  };
}

function markAssignmentInspectionCompleted(equipment, schema, inspection, userId = null) {
  const assignments = Array.isArray(equipment?.schemaAssignments) ? [...equipment.schemaAssignments] : [];
  const idx = assignments.findIndex((assignment) =>
    String(assignment?.schemaId || '') === String(schema?._id || '') ||
    (!!schema?.systemKey && assignment?.schemaKey === schema.systemKey)
  );
  if (idx < 0) return false;

  const current = assignments[idx];
  const cycle = assignmentCycle(current, schema);
  const status = inspection?.status === 'Passed' ? 'Passed' : 'Failed';
  const inspectedAt = inspection?.inspectionDate ? new Date(inspection.inspectionDate) : new Date();
  const nextDueAt = status === 'Passed' ? addCycle(inspectedAt, cycle.value, cycle.unit) : null;

  assignments[idx] = {
    ...current,
    values: {
      ...(current.values || {}),
      cycleValue: cycle.value,
      cycleUnit: cycle.unit,
      lastInspectionDate: inspectedAt,
      lastInspectionStatus: status,
      lastInspectionId: inspection?._id || null,
      nextInspectionDate: nextDueAt,
      previousInspectionDate: inspectedAt,
      completedBy: userId || null
    }
  };
  equipment.schemaAssignments = assignments;
  if (equipment.markModified) equipment.markModified('schemaAssignments');
  return true;
}

module.exports = {
  CYCLE_UNITS,
  CYCLE_FIELD_KEYS,
  addCycle,
  applySchemaCycleDefaults,
  assignmentCycle,
  markAssignmentInspectionCompleted,
  normalizeCycleUnit,
  normalizeCycleValue,
  schemaDefaultCycle,
  stripCycleDataFields
};
