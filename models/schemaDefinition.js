const mongoose = require('mongoose');

const { Schema } = mongoose;

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect'];
const TARGET_LEVELS = ['site', 'zone', 'equipment'];

const SchemaDataFieldSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    fieldType: { type: String, enum: FIELD_TYPES, default: 'text' },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    visibleWhen: { type: Schema.Types.Mixed, default: null },
    rules: { type: Schema.Types.Mixed, default: null }
  },
  { _id: true }
);

const SchemaQuestionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true },
    textI18n: {
      eng: { type: String, default: '' },
      hun: { type: String, default: '' }
    },
    group: { type: String, default: 'General', trim: true },
    table: { type: String, default: '', trim: true },
    number: { type: Number, default: null },
    equipmentType: { type: String, default: '', trim: true },
    protectionTypes: { type: [String], default: [] },
    inspectionTypes: { type: [String], default: [] },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    severityDefault: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null },
    origin: { type: String, enum: ['system', 'tenant'], default: 'system' }
  },
  { _id: true }
);

const SchemaDefinitionSchema = new Schema(
  {
    scope: { type: String, enum: ['system', 'tenant'], required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    systemKey: { type: String, default: null, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['compliance', 'maintenance'], required: true, index: true },
    description: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    systemProvided: { type: Boolean, default: false, index: true },
    targetLevels: { type: [String], enum: TARGET_LEVELS, default: ['site', 'zone', 'equipment'] },
    ruleset: { type: String, default: null, trim: true },
    dataFields: { type: [SchemaDataFieldSchema], default: [] },
    questions: { type: [SchemaQuestionSchema], default: [] },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

SchemaDefinitionSchema.index(
  { scope: 1, systemKey: 1 },
  { unique: true, sparse: true, name: 'uniq_system_schema_key' }
);
SchemaDefinitionSchema.index(
  { tenantId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'tenant' },
    name: 'uniq_tenant_schema_name'
  }
);

SchemaDefinitionSchema.pre('validate', function (next) {
  if (this.scope === 'system') {
    this.tenantId = null;
    this.systemProvided = true;
  }
  if (this.type !== 'compliance') {
    this.questions = [];
  }
  this.dataFields = (this.dataFields || []).map((f, idx) => ({
    ...f,
    order: Number.isFinite(Number(f.order)) ? Number(f.order) : idx + 1
  }));
  this.questions = (this.questions || []).map((q, idx) => ({
    ...q,
    key: q.key || `q_${idx + 1}`,
    order: Number.isFinite(Number(q.order)) ? Number(q.order) : idx + 1
  }));
  next();
});

module.exports = mongoose.model('SchemaDefinition', SchemaDefinitionSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.TARGET_LEVELS = TARGET_LEVELS;
