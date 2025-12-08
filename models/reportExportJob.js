const mongoose = require('mongoose');

const ReportExportJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['latest_inspections', 'project_full'], required: true },
    params: {
      siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site' },
      zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' },
      includeImages: { type: Boolean, default: true }
    },
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'], default: 'queued', index: true },
    blobPath: { type: String },
    blobSize: { type: Number },
    errorMessage: { type: String },
    meta: mongoose.Schema.Types.Mixed,
    startedAt: { type: Date },
    finishedAt: { type: Date }
  },
  { timestamps: true }
);

ReportExportJobSchema.index({ tenantId: 1, createdAt: -1 });
ReportExportJobSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('ReportExportJob', ReportExportJobSchema);
