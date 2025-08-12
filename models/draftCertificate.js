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
  sharePointFileUrl: String,
  sharePointDocxUrl: String,
  sharePointFileId: String,
  sharePointDocxId: String,
  sharePointFolderId: String,
  sharePointFolderUrl: String,

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  company: {
    type: String
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('DraftCertificate', DraftCertificateSchema);