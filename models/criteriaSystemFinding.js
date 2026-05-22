const mongoose = require('mongoose');

const { Schema } = mongoose;

const CriteriaSystemFindingSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    criteriaSystemId: { type: Schema.Types.ObjectId, ref: 'CriteriaSystem', required: true, index: true },
    sourceDomain: {
      type: String,
      enum: ['criteria_compliance', 'criteria_maintenance', 'explosion_safety'],
      required: true,
      index: true
    },
    reason: { type: String, enum: ['expired', 'failed_question'], required: true, index: true },
    status: {
      type: String,
      enum: [
        'open',
        'resolved',
        'ignored',
        'archived_due_to_inactive',
        'archived_due_to_assignment_excluded',
        'archived_due_to_cycle_change'
      ],
      default: 'open',
      index: true
    },
    priority: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null, index: true },
    dueAt: { type: Date, default: null, index: true },
    completionId: { type: Schema.Types.ObjectId, ref: 'CriteriaSystemCompletion', default: null },
    inspectionId: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null },
    questionId: { type: Schema.Types.ObjectId, default: null },
    reasonText: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionReason: { type: String, default: '' }
  },
  { timestamps: true }
);

CriteriaSystemFindingSchema.index({ tenantId: 1, equipmentId: 1, criteriaSystemId: 1, reason: 1, status: 1 });

module.exports = mongoose.model('CriteriaSystemFinding', CriteriaSystemFindingSchema);
