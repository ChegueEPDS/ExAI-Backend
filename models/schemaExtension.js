const mongoose = require('mongoose');

const { Schema } = mongoose;

const ExtraQuestionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true },
    textI18n: {
      eng: { type: String, default: '' },
      hun: { type: String, default: '' }
    },
    group: { type: String, default: 'Tenant additional', trim: true },
    table: { type: String, default: 'ADD', trim: true },
    number: { type: Number, default: null },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    severityDefault: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { _id: true, timestamps: true }
);

const SchemaExtensionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    schemaId: { type: Schema.Types.ObjectId, ref: 'SchemaDefinition', required: true, index: true },
    extraQuestions: { type: [ExtraQuestionSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

SchemaExtensionSchema.index(
  { tenantId: 1, schemaId: 1 },
  { unique: true, name: 'uniq_tenant_schema_extension' }
);

module.exports = mongoose.model('SchemaExtension', SchemaExtensionSchema);
