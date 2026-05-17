const mongoose = require('mongoose');

const { Schema } = mongoose;

const ENTITY_TYPES = ['site', 'zone', 'equipment'];
const SECTIONS = ['Basic', 'Ex Data', 'Custom Data'];

const FieldLayoutItemSchema = new Schema(
  {
    fieldKey: { type: String, required: true, trim: true },
    source: { type: String, enum: ['system', 'custom'], required: true },
    label: { type: String, trim: true },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    section: { type: String, enum: SECTIONS, default: 'Basic' }
  },
  { _id: false }
);

const FieldLayoutSchema = new Schema(
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
    items: {
      type: [FieldLayoutItemSchema],
      default: []
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

FieldLayoutSchema.index(
  { tenantId: 1, entityType: 1 },
  { unique: true, name: 'uniq_tenant_entity_field_layout' }
);

module.exports = mongoose.model('FieldLayout', FieldLayoutSchema);
module.exports.ENTITY_TYPES = ENTITY_TYPES;
module.exports.SECTIONS = SECTIONS;
