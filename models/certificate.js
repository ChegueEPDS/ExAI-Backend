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
  docType: { type: String, enum: ['certificate', 'manufacturer_declaration', 'unknown'], default: 'unknown' },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvedAt: { type: Date, default: null },
  
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    index: true,
    required: false,
  },
  visibility: {
    type: String,
    enum: ['public', 'private'],
    default: 'private',
    index: true
  },
}, { timestamps: true });

// 🔹 Automatikus tenant kitöltés CreatedBy alapján (company mező kivezetve)
CertificateSchema.pre('save', async function (next) {
  try {
    // ⚠️ Ha PUBLIC, akkor maradhat tenantId=null (ne töltsük vissza)
    if (this.visibility === 'public') {
      return next();
    }

    // Csak nem-PUBLIC esetben töltsük be a tenantId-t
    if (this.isModified('createdBy') || !this.tenantId) {
      const user = await mongoose.model('User').findById(this.createdBy).select('tenantId');
      if (!user) return next(new Error('Invalid CreatedBy user'));

      if (!this.tenantId && user.tenantId) {
        this.tenantId = user.tenantId;
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
});

// 🔹 Egyedi index tenanton belül: tenantId + certNo + issueDate (csak ahol van tenantId)
CertificateSchema.index(
  { tenantId: 1, certNo: 1, issueDate: 1 },
  {
    unique: true,
    name: 'uniq_tenant_certNo_issueDate',
    partialFilterExpression: { tenantId: { $exists: true, $type: 'objectId' } },
    collation: { locale: 'en', strength: 2 },
  }
);

// 🔹 Egyedi index publikus rekordokra: visibility='public' + certNo + issueDate
CertificateSchema.index(
  { visibility: 1, certNo: 1, issueDate: 1 },
  {
    unique: true,
    name: 'uniq_public_certNo_issueDate',
    partialFilterExpression: { visibility: 'public' },
    collation: { locale: 'en', strength: 2 },
  }
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