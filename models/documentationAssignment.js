const mongoose = require('mongoose');

const DocumentationAssignmentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    documentationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Documentation', required: true, index: true },
    targetType: { type: String, enum: ['site', 'zone'], required: true, index: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    attachedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'attachedAt', updatedAt: false } }
);

DocumentationAssignmentSchema.index(
  { tenantId: 1, documentationId: 1, targetType: 1, targetId: 1 },
  { unique: true }
);
DocumentationAssignmentSchema.index({ tenantId: 1, targetType: 1, targetId: 1 });

module.exports = mongoose.models.DocumentationAssignment || mongoose.model('DocumentationAssignment', DocumentationAssignmentSchema);
