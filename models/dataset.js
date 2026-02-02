const mongoose = require('mongoose');

const DatasetSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'in_review', 'approved', 'rejected'], default: 'draft', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    approvedAt: { type: Date, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DatasetSchema.index({ tenantId: 1, projectId: 1, version: 1 }, { unique: true });
DatasetSchema.index({ tenantId: 1, projectId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Dataset', DatasetSchema);

