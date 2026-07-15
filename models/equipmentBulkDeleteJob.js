const mongoose = require('mongoose');

const EquipmentBulkDeleteJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantName: { type: String, default: '' },
    equipmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Dataplate', required: true }],
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'], default: 'queued', index: true },
    progress: {
      processed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      updatedAt: { type: Date, default: null }
    },
    result: {
      deletedCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
      failures: { type: [mongoose.Schema.Types.Mixed], default: [] }
    },
    errorMessage: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

EquipmentBulkDeleteJobSchema.index({ tenantId: 1, createdAt: -1 });
EquipmentBulkDeleteJobSchema.index({ userId: 1, createdAt: -1 });
EquipmentBulkDeleteJobSchema.index({ status: 1, createdAt: 1 });
EquipmentBulkDeleteJobSchema.index({ status: 1, lastHeartbeatAt: 1 });

module.exports = mongoose.model('EquipmentBulkDeleteJob', EquipmentBulkDeleteJobSchema);
