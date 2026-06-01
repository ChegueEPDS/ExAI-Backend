const mongoose = require('mongoose');
const CustomFieldDefinition = require('../models/customFieldDefinition');
const FieldLayout = require('../models/fieldLayout');
const QuestionTypeMapping = require('../models/questionTypeMapping');

const ENTITY_TYPES = ['site', 'zone', 'equipment'];
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect'];
const EQUIPMENT_TYPES = [
  'General',
  'Motors',
  'Electrical Machines',
  'Lighting',
  'Installation',
  'Installation Electrical Machines',
  'Installation Heating System',
  'Installation Motors',
  'Environment'
];
const SECTIONS = ['Basic', 'Ex Data', 'Custom Data'];

const SYSTEM_FIELDS = {
  site: [
    { fieldKey: 'Name', label: 'Site name', section: 'Basic', required: true },
    { fieldKey: 'Client', label: 'Client', section: 'Basic', required: true },
    { fieldKey: 'Note', label: 'Note', section: 'Basic' }
  ],
  zone: [
    { fieldKey: 'Name', label: 'Zone name', section: 'Basic', required: true },
    { fieldKey: 'Description', label: 'Description', section: 'Basic' },
    { fieldKey: 'SkidID', label: 'Skid ID', section: 'Basic' },
    { fieldKey: 'SkidDescription', label: 'Skid Description', section: 'Basic' },
    { fieldKey: 'ProjectID', label: 'Project ID', section: 'Basic' }
  ],
  equipment: [
    { fieldKey: 'EqID', label: 'Equipment ID', section: 'Basic' },
    { fieldKey: 'Qualitycheck', label: 'Quality check', section: 'Basic' },
    { fieldKey: 'TagNo', label: 'Tag No.', section: 'Basic' },
    { fieldKey: 'Equipment Type', label: 'Equipment Type', section: 'Basic' },
    { fieldKey: 'Manufacturer', label: 'Manufacturer', section: 'Basic' },
    { fieldKey: 'Model/Type', label: 'Model/Type', section: 'Basic' },
    { fieldKey: 'Serial Number', label: 'Serial Number', section: 'Basic' },
    { fieldKey: 'IP rating', label: 'IP rating', section: 'Basic' },
    { fieldKey: 'Max Ambient Temp', label: 'Max Ambient Temp', section: 'Basic' },
    { fieldKey: 'Other Info', label: 'Notes', section: 'Basic' }
  ]
};

function isValidObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(value);
}

function toObjectId(value) {
  return isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
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

function isAdmin(req) {
  const role = req.role || req.user?.role;
  return role === 'Admin' || role === 'SuperAdmin';
}

function isSuperAdmin(req) {
  const role = req.role || req.user?.role;
  return role === 'SuperAdmin';
}

function assertEntityType(entityType) {
  if (!ENTITY_TYPES.includes(entityType)) {
    const err = new Error('Invalid entityType.');
    err.status = 400;
    throw err;
  }
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return Array.from(
    new Set(options.map((v) => String(v || '').trim()).filter(Boolean))
  );
}

function normalizeEquipmentTypes(values) {
  const input = Array.isArray(values) ? values : [];
  const out = input.map((v) => String(v || '').trim()).filter((v) => EQUIPMENT_TYPES.includes(v));
  return out.length ? Array.from(new Set(out)) : ['General'];
}

function coerceValue(def, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (def.fieldType === 'boolean') return false;
    if (def.fieldType === 'multiselect') return [];
    return '';
  }

  if (def.fieldType === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }

  if (def.fieldType === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }

  if (def.fieldType === 'date') {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value || '') : d.toISOString();
  }

  if (def.fieldType === 'multiselect') {
    const raw = Array.isArray(value) ? value : [value];
    const next = raw.map((v) => String(v || '').trim()).filter(Boolean);
    if (Array.isArray(def.options) && def.options.length) {
      const allowed = new Set(def.options);
      return next.filter((v) => allowed.has(v));
    }
    return next;
  }

  if (def.fieldType === 'select') {
    const s = String(value || '').trim();
    if (Array.isArray(def.options) && def.options.length && s && !def.options.includes(s)) return '';
    return s;
  }

  return String(value ?? '');
}

async function sanitizeCustomFields({ tenantId, entityType, values }) {
  assertEntityType(entityType);
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId || !values || typeof values !== 'object' || Array.isArray(values)) return {};

  const defs = await CustomFieldDefinition.find({
    tenantId: tenantObjectId,
    entityType,
    active: true
  }).lean();
  const byKey = new Map(defs.map((d) => [String(d.key), d]));
  const out = {};
  Object.keys(values).forEach((key) => {
    const def = byKey.get(key);
    if (!def) return;
    out[key] = coerceValue(def, values[key]);
  });
  return out;
}

async function getRelevantEquipmentTypesForDevice(equipmentDoc, tenantId) {
  const rawType =
    (equipmentDoc && typeof equipmentDoc === 'object'
      ? equipmentDoc['Equipment Type'] || equipmentDoc.EquipmentType || equipmentDoc.equipmentType || ''
      : '') || '';

  const normalized = String(rawType).toLowerCase().trim();
  const result = new Set(['General']);
  if (!normalized) return result;

  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) return result;

  const mappings = await QuestionTypeMapping.find({ tenantId: tenantObjectId, active: true })
    .select('equipmentPattern equipmentTypes')
    .lean();

  mappings.forEach((m) => {
    const pattern = String(m.equipmentPattern || '').toLowerCase().trim();
    if (!pattern || !normalized.includes(pattern)) return;
    (m.equipmentTypes || []).forEach((t) => {
      if (t) result.add(String(t));
    });
  });

  return result;
}

function isCustomFieldRelevantForEquipment(def, relevantTypes) {
  const types = Array.isArray(def?.equipmentTypes) && def.equipmentTypes.length
    ? def.equipmentTypes
    : ['General'];
  if (types.includes('General')) return true;
  return types.some((t) => relevantTypes.has(t));
}

function systemLayoutItems(entityType) {
  assertEntityType(entityType);
  return (SYSTEM_FIELDS[entityType] || []).map((f, idx) => ({
    fieldKey: f.fieldKey,
    source: 'system',
    label: f.label,
    visible: true,
    order: (idx + 1) * 10,
    section: f.section || 'Basic',
    required: !!f.required,
    lockedVisible: !!f.required
  }));
}

async function buildLayout({ tenantId, entityType }) {
  assertEntityType(entityType);
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) {
    const err = new Error('Missing tenantId.');
    err.status = 400;
    throw err;
  }

  const [layout, customFields] = await Promise.all([
    FieldLayout.findOne({ tenantId: tenantObjectId, entityType }).lean(),
    CustomFieldDefinition.find({ tenantId: tenantObjectId, entityType, active: true }).lean()
  ]);

  const defaults = [
    ...systemLayoutItems(entityType),
    ...customFields.map((field, idx) => ({
      fieldKey: field.key,
      source: 'custom',
      label: field.label,
      visible: true,
      order: 10000 + ((idx + 1) * 10),
      section: 'Custom Data',
      customField: field
    }))
  ];

  const savedByKey = new Map(
    (layout?.items || []).map((item) => [`${item.source}:${item.fieldKey}`, item])
  );

  return defaults
    .map((item) => {
      const saved = savedByKey.get(`${item.source}:${item.fieldKey}`);
      const visible = item.lockedVisible ? true : (saved?.visible ?? item.visible);
      return {
        ...item,
        label: saved?.label || item.label,
        visible,
        order: Number.isFinite(Number(saved?.order)) ? Number(saved.order) : item.order,
        section: SECTIONS.includes(saved?.section) ? saved.section : item.section
      };
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.label).localeCompare(String(b.label)));
}

module.exports = {
  ENTITY_TYPES,
  FIELD_TYPES,
  EQUIPMENT_TYPES,
  SECTIONS,
  SYSTEM_FIELDS,
  assertEntityType,
  buildLayout,
  coerceValue,
  getRelevantEquipmentTypesForDevice,
  isAdmin,
  isCustomFieldRelevantForEquipment,
  isSuperAdmin,
  normalizeEquipmentTypes,
  normalizeKey,
  normalizeOptions,
  sanitizeCustomFields,
  systemLayoutItems,
  toObjectId
};
