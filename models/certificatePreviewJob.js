const mongoose = require('mongoose');

const CertificatePreviewJobSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['created', 'queued', 'processing', 'done', 'error'],
      default: 'created',
      index: true
    },
    scheme: { type: String, default: 'ATEX' },
    fileName: { type: String, required: true },
    contentType: { type: String, default: 'application/pdf' },
    size: { type: Number, default: 0 },
    blobPath: { type: String, required: true },
    recognizedText: { type: String, default: '' },
    extracted: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

CertificatePreviewJobSchema.index({ tenantId: 1, createdBy: 1, createdAt: -1 });
CertificatePreviewJobSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model('CertificatePreviewJob', CertificatePreviewJobSchema);
