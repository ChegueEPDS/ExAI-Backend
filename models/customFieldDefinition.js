const mongoose = require('mongoose');

const { Schema } = mongoose;

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect'];
const ENTITY_TYPES = ['site', 'zone', 'equipment'];
const EQUIPMENT_TYPES = [
  'General',
  'Motors',
  'Lighting',
  'Installation',
  'Installation Heating System',
  'Installation Motors',
  'Environment'
];

const CustomFieldDefinitionSchema = new Schema(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    entityType: {
      type: String,
      enum: ENTITY_TYPES,
      required: true,
      index: true
    },
    key: {
      type: String,
      required: true,
      trim: true
    },
    label: {
      type: String,
      required: true,
      trim: true
    },
    fieldType: {
      type: String,
      enum: FIELD_TYPES,
      required: true,
      default: 'text'
    },
    options: {
      type: [String],
      default: []
    },
    required: {
      type: Boolean,
      default: false
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    },
    showInList: {
      type: Boolean,
      default: true
    },
    showInExport: {
      type: Boolean,
      default: true
    },
    equipmentTypes: {
      type: [String],
      enum: EQUIPMENT_TYPES,
      default: undefined
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

CustomFieldDefinitionSchema.index(
  { tenantId: 1, entityType: 1, key: 1 },
  { unique: true, name: 'uniq_tenant_entity_custom_field_key' }
);

CustomFieldDefinitionSchema.pre('validate', function (next) {
  if (this.entityType !== 'equipment') {
    this.equipmentTypes = undefined;
  } else if (!Array.isArray(this.equipmentTypes) || !this.equipmentTypes.length) {
    this.equipmentTypes = ['General'];
  }

  if (this.fieldType !== 'select' && this.fieldType !== 'multiselect') {
    this.options = [];
  }

  next();
});

module.exports = mongoose.model('CustomFieldDefinition', CustomFieldDefinitionSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.ENTITY_TYPES = ENTITY_TYPES;
module.exports.EQUIPMENT_TYPES = EQUIPMENT_TYPES;
