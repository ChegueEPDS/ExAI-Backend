const mongoose = require('mongoose');

const { Schema } = mongoose;

const CycleSchema = new Schema(
  {
    value: { type: Number, min: 1, default: 1 },
    unit: { type: String, enum: ['day', 'month', 'year'], default: 'year' }
  },
  { _id: false }
);

const CriteriaCustomFieldSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    fieldType: {
      type: String,
      enum: ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect'],
      default: 'text'
    },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    active: { type: Boolean, default: true }
  },
  { _id: true }
);

const CriteriaQuestionSchema = new Schema(
  {
    text: { type: String, required: true, trim: true },
    origin: { type: String, enum: ['global_system', 'tenant_additional'], default: 'tenant_additional' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true }
  },
  { _id: true }
);

const CriteriaSystemSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['compliance', 'maintenance'], required: true, index: true },
    assignmentScope: { type: String, enum: ['general', 'device_type', 'manual'], default: 'manual', index: true },
    equipmentTypes: { type: [String], default: [] },
    cycle: { type: CycleSchema, default: () => ({ value: 1, unit: 'year' }) },
    systemKey: { type: String, default: null, index: true },
    isSystemProvided: { type: Boolean, default: false, index: true },
    active: { type: Boolean, default: true, index: true },
    customFields: { type: [CriteriaCustomFieldSchema], default: [] },
    questions: { type: [CriteriaQuestionSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

CriteriaSystemSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, name: 'uniq_tenant_criteria_system_name' }
);
CriteriaSystemSchema.index(
  { tenantId: 1, systemKey: 1 },
  { unique: true, sparse: true, name: 'uniq_tenant_criteria_system_key' }
);

module.exports = mongoose.model('CriteriaSystem', CriteriaSystemSchema);
