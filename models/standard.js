const mongoose = require('mongoose');

const StandardSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    standardId: { type: String, required: true, trim: true, index: true }, // e.g. IEC 60079-0
    edition: { type: String, default: '', trim: true }, // e.g. 2017
    aliases: { type: [String], default: [] }, // search helpers
    modeHint: { type: String, enum: ['gas', 'dust', 'both', 'unknown'], default: 'unknown', index: true },
    status: { type: String, enum: ['processing', 'ready', 'error'], default: 'processing', index: true },
    error: { type: String, default: '' },
    sourceFiles: [
      {
        filename: String,
        contentType: String,
        blobPath: String,
        sha256: String,
        uploadedAt: { type: Date, default: Date.now },
      }
    ],
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

StandardSchema.index({ tenantId: 1, standardId: 1, edition: 1 }, { unique: false });
StandardSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Standard', StandardSchema);

