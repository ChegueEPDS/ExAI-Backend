const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
    certNo: { type: String, required: true },
    scheme: { type: String },
    status: { type: String },
    issueDate: { type: String },
    applicant: { type: String },
    protection: { type: String },
    equipment: { type: String },
    manufacturer: { type: String },
    exmarking: { type: String },
    fileName: { type: String },
    fileUrl: { type: String },
    fileId: { type: String },
    docxUrl: { type: String },
    docxId: { type: String },
    folderId: { type: String },
    folderUrl: { type: String },
    sharePointFileUrl: { type: String },
    sharePointDocxUrl: { type: String },
    sharePointFileId: { type: String },
    sharePointDocxId: { type: String },
    sharePointFolderId: { type: String },
    sharePointFolderUrl: { type: String },
    xcondition: { type: Boolean, default: false },
    ucondition: { type: Boolean, default: false },
    specCondition: { type: String },
    description: { type: String },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    company: {
      type: String,
      required: true
    },
  }, { timestamps: true });
  
  // 🔹 Automatikus Company kitöltés CreatedBy alapján
  CertificateSchema.pre('save', async function (next) {
    if (!this.isModified('createdBy')) return next();
  
    try {
      const user = await mongoose.model('User').findById(this.createdBy);
      if (!user) return next(new Error('Invalid CreatedBy user'));
      this.company = user.company;
      next();
    } catch (error) {
      next(error);
    }
  });
  
  module.exports = mongoose.model('Certificate', CertificateSchema);