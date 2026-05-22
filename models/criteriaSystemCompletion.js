const mongoose = require('mongoose');

const { Schema } = mongoose;

const CriteriaSystemCompletionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    criteriaSystemId: { type: Schema.Types.ObjectId, ref: 'CriteriaSystem', required: true, index: true },
    completedAt: { type: Date, required: true, index: true },
    note: { type: String, default: '' },
    completedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    source: { type: String, enum: ['maintenance', 'inspection'], required: true, index: true },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null, index: true }
  },
  { timestamps: true }
);

CriteriaSystemCompletionSchema.index({ tenantId: 1, equipmentId: 1, criteriaSystemId: 1, completedAt: -1 });

module.exports = mongoose.model('CriteriaSystemCompletion', CriteriaSystemCompletionSchema);
