const mongoose = require('mongoose');

const { Schema } = mongoose;

const AssignmentCycleSchema = new Schema(
  {
    value: { type: Number, min: 1 },
    unit: { type: String, enum: ['day', 'month', 'year'] }
  },
  { _id: false }
);

const DeviceCriteriaSystemAssignmentSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    criteriaSystemId: { type: Schema.Types.ObjectId, ref: 'CriteriaSystem', required: true, index: true },
    state: { type: String, enum: ['included', 'excluded'], default: 'included', index: true },
    cycleOverride: { type: AssignmentCycleSchema, default: null },
    startDate: { type: Date, default: null },
    active: { type: Boolean, default: true, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

DeviceCriteriaSystemAssignmentSchema.index(
  { tenantId: 1, equipmentId: 1, criteriaSystemId: 1 },
  { unique: true, name: 'uniq_device_criteria_assignment' }
);

module.exports = mongoose.model('DeviceCriteriaSystemAssignment', DeviceCriteriaSystemAssignmentSchema);
