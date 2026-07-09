const mongoose = require('mongoose');

const DocumentationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    alias: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    blobPath: { type: String, required: true },
    blobUrl: { type: String, default: '' },
    contentType: { type: String, required: true },
    size: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null, index: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

DocumentationSchema.index({ tenantId: 1, createdAt: -1 });
DocumentationSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.models.Documentation || mongoose.model('Documentation', DocumentationSchema);
