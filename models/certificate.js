const mongoose = require('mongoose');
const CompanyCertificateLink = require('./companyCertificateLink');

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
  try {
    // Ha a company már be van állítva (pl. 'global'), hagyjuk békén
    if (this.company) return next();

    // Csak akkor töltsük ki user.company-vel, ha még nincs érték
    if (this.isModified('createdBy')) {
      const user = await mongoose.model('User').findById(this.createdBy);
      if (!user) return next(new Error('Invalid CreatedBy user'));
      this.company = user.company || 'global';
    }
    next();
  } catch (err) {
    next(err);
  }
});

// 🔹 Egyedi index cégenként: certNo + issueDate
CertificateSchema.index(
  { company: 1, certNo: 1, issueDate: 1 },
  { unique: true, name: 'uniq_company_certNo_issueDate', collation: { locale: 'en', strength: 2 } }
);

// --- Cascade cleanup: töröljük a linkeket, ha egy certificate törlődik ---

// findByIdAndDelete / findOneAndDelete esetek
CertificateSchema.post('findOneAndDelete', async function (doc) {
  try {
    if (doc?._id) {
      await mongoose.model('CompanyCertificateLink').deleteMany({ certId: doc._id });
    }
  } catch (err) {
    console.warn('⚠️ [cascade] Link törlés sikertelen lehetett (findOneAndDelete):', doc?._id?.toString(), err?.message || err);
  }
});

// Document-alapú törlés esetére (doc.deleteOne() / doc.remove())
CertificateSchema.post('deleteOne', { document: true, query: false }, async function () {
  try {
    await mongoose.model('CompanyCertificateLink').deleteMany({ certId: this._id });
  } catch (err) {
    console.warn('⚠️ [cascade] Link törlés sikertelen lehetett (doc.deleteOne):', this._id?.toString(), err?.message || err);
  }
});

// (Opcionális) Régebbi kódokhoz: doc.remove()
CertificateSchema.post('remove', { document: true, query: false }, async function () {
  try {
    await mongoose.model('CompanyCertificateLink').deleteMany({ certId: this._id });
  } catch (err) {
    console.warn('⚠️ [cascade] Link törlés sikertelen lehetett (doc.remove):', this._id?.toString(), err?.message || err);
  }
});

module.exports = mongoose.model('Certificate', CertificateSchema);