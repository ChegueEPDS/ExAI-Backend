const { normalizeRbValues } = require('./schemaRules/rbRules');

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect']);

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function coerceFieldValue(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (field.fieldType === 'boolean') return false;
    if (field.fieldType === 'multiselect') return [];
    return '';
  }
  if (field.fieldType === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (field.fieldType === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(s);
  }
  if (field.fieldType === 'date') {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : String(value || '');
  }
  if (field.fieldType === 'multiselect') {
    const values = Array.isArray(value) ? value : [value];
    const out = values.map((v) => String(v || '').trim()).filter(Boolean);
    return Array.isArray(field.options) && field.options.length
      ? out.filter((v) => field.options.includes(v))
      : out;
  }
  if (field.fieldType === 'select') {
    const s = String(value || '').trim();
    return Array.isArray(field.options) && field.options.length && s && !field.options.includes(s) ? '' : s;
  }
  return String(value ?? '');
}

function sanitizeDataFields(fields = []) {
  return (Array.isArray(fields) ? fields : [])
    .map((f, idx) => {
      const label = String(f?.label || '').trim();
      const key = normalizeKey(f?.key || label);
      return {
        key,
        label,
        fieldType: FIELD_TYPES.has(f?.fieldType) ? f.fieldType : 'text',
        options: Array.isArray(f?.options) ? f.options.map((x) => String(x || '').trim()).filter(Boolean) : [],
        required: !!f?.required,
        order: Number.isFinite(Number(f?.order)) ? Number(f.order) : idx + 1,
        active: f?.active !== false,
        visibleWhen: f?.visibleWhen || null,
        rules: f?.rules || null
      };
    })
    .filter((f) => f.key && f.label);
}

function sanitizeQuestions(questions = [], origin = 'tenant') {
  return (Array.isArray(questions) ? questions : [])
    .map((q, idx) => {
      const text = String(q?.text || q?.questionText?.eng || q?.textI18n?.eng || '').trim();
      const key = normalizeKey(q?.key || `${q?.table || 'q'}_${q?.group || ''}_${q?.number ?? idx + 1}`) || `q_${idx + 1}`;
      return {
        _id: q?._id,
        key,
        text,
        textI18n: {
          eng: String(q?.textI18n?.eng || q?.questionText?.eng || text || '').trim(),
          hun: String(q?.textI18n?.hun || q?.questionText?.hun || '').trim()
        },
        group: String(q?.group || q?.equipmentType || 'General').trim(),
        table: String(q?.table || '').trim(),
        number: q?.number != null ? Number(q.number) : null,
        equipmentType: String(q?.equipmentType || q?.group || 'General').trim(),
        protectionTypes: Array.isArray(q?.protectionTypes)
          ? q.protectionTypes.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
        inspectionTypes: Array.isArray(q?.inspectionTypes)
          ? q.inspectionTypes.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
        order: Number.isFinite(Number(q?.order)) ? Number(q.order) : idx + 1,
        active: q?.active !== false,
        severityDefault: ['P1', 'P2', 'P3', 'P4'].includes(q?.severityDefault) ? q.severityDefault : null,
        origin
      };
    })
    .filter((q) => q.text);
}

function validateSchemaValues(schema, values = {}) {
  if (schema?.ruleset === 'rb_v1' || schema?.systemKey === 'rb') {
    return normalizeRbValues(values);
  }
  const out = {};
  const fields = Array.isArray(schema?.dataFields) ? schema.dataFields.filter((f) => f.active !== false) : [];
  for (const field of fields) {
    const value = coerceFieldValue(field, values[field.key]);
    if (field.required) {
      const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
      if (empty) {
        const err = new Error(`${field.label || field.key} is required.`);
        err.status = 400;
        throw err;
      }
    }
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

module.exports = {
  normalizeKey,
  sanitizeDataFields,
  sanitizeQuestions,
  validateSchemaValues
};
