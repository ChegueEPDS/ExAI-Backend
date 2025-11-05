const mongoose = require('mongoose');

const DraftCertificateSchema = new mongoose.Schema({
  uploadId: { type: String, required: true },
  fileName: String,
  originalPdfPath: String,
  docxPath: String,
  recognizedText: String,
  extractedData: Object,
  status: { type: String, default: 'draft' }, // draft, ready, error, etc.

  // 🔽 Új mezők
  fileUrl: String,
  fileId: String,
  docxUrl: String,
  docxId: String,
  folderId: String,
  folderUrl: String,
  blobPdfPath: { type: String },   // pl. "certificates/uploads/<uploadId>/<fileName>.pdf"
  blobDocxPath: { type: String },  // pl. "certificates/uploads/<uploadId>/<fileName>.docx"

  // 🔗 Request binding (optional): when a draft is an answer to a specific request
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CertificateRequest', index: true },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

DraftCertificateSchema.index(
  { tenantId: 1, uploadId: 1, fileName: 1 },
  {
    unique: true,
    name: 'uniq_tenant_draft_upload_file',
    partialFilterExpression: { tenantId: { $exists: true, $type: 'objectId' } }
  }
);

// Ensure a request has at most one active (non-finalized) draft attached
DraftCertificateSchema.index(
  { requestId: 1, status: 1 },
  {
    unique: true,
    name: 'uniq_active_draft_per_request',
    partialFilterExpression: {
      requestId: { $exists: true, $ne: null },
      status: { $in: ['draft', 'ready', 'error'] }
    }
  }
);

DraftCertificateSchema.pre('save', async function (next) {
  try {
    const user = await mongoose.model('User').findById(this.createdBy).select('tenantId');
    if (!user) return next(new Error('Invalid createdBy user'));

    if (!this.tenantId && user.tenantId) {
      this.tenantId = user.tenantId;
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

module.exports = mongoose.model('DraftCertificate', DraftCertificateSchema);