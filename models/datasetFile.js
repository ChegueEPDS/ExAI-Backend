const mongoose = require('mongoose');

const DatasetFileSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dataset', required: true, index: true },
    datasetVersion: { type: Number, required: true, index: true },

    filename: { type: String, required: true, trim: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },

    sha256: { type: String, required: true, index: true },
    parserVersion: { type: String, default: 'v1' },

    storage: {
      provider: { type: String, enum: ['azure_blob', 'local'], default: 'azure_blob' },
      blobPath: { type: String, default: '' },
    },

    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    indexingStatus: { type: String, enum: ['queued', 'processing', 'done', 'error'], default: 'queued', index: true },
    indexingError: { type: String, default: '' },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DatasetFileSchema.index({ tenantId: 1, projectId: 1, datasetVersion: 1, approvalStatus: 1, updatedAt: -1 });
DatasetFileSchema.index({ datasetId: 1, filename: 1, sha256: 1 }, { unique: true });

module.exports = mongoose.model('DatasetFile', DatasetFileSchema);

