const mongoose = require('mongoose');

const EquipmentImportJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', required: true, index: true },
    sourceBlobPath: { type: String, required: true },
    sourceFileName: { type: String, default: 'equipment-import.xlsx' },
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'], default: 'queued', index: true },
    progress: {
      processed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      updatedAt: { type: Date, default: null }
    },
    result: {
      createdCount: { type: Number, default: 0 },
      updatedCount: { type: Number, default: 0 },
      inspectionsCreated: { type: Number, default: 0 },
      issuesCount: { type: Number, default: 0 },
      errorReportBlobPath: { type: String, default: null },
      errorReportFileName: { type: String, default: null },
      errorReportDownloadUrl: { type: String, default: null }
    },
    errorMessage: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

EquipmentImportJobSchema.index({ tenantId: 1, createdAt: -1 });
EquipmentImportJobSchema.index({ userId: 1, createdAt: -1 });
EquipmentImportJobSchema.index({ status: 1, createdAt: 1 });
EquipmentImportJobSchema.index({ status: 1, lastHeartbeatAt: 1 });
EquipmentImportJobSchema.index({ finishedAt: 1 });

module.exports = mongoose.model('EquipmentImportJob', EquipmentImportJobSchema);
