const mongoose = require('mongoose');

const SchemaAssignmentSchema = new mongoose.Schema(
  {
    schemaId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchemaDefinition', required: true },
    schemaKey: { type: String, default: null, index: true },
    attachedAt: { type: Date, default: Date.now },
    attachedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    values: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const SiteSchema = new mongoose.Schema({
  Name: { type: String, required: true },
  Client: { type: String, required: true },
  Note: { type: String },

  CreatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // 🔒 Tenant scoping (company removed)
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true
  },

  // 🗂️ Blob Storage prefix for this site's files
  // Example: "TENANT_FOO/projects/My Site/"
  blobPrefix: { type: String },

  // 📎 Files stored in Azure Blob (legacy OneDrive/SharePoint removed)
  documents: [
    {
      name: { type: String },              // original filename (cleaned)
      alias: { type: String },             // user-visible display name
      blobPath: { type: String },          // container-relative path e.g. "TENANT_X/projects/SiteA/file.pdf"
      blobUrl: { type: String },           // optional direct URL (no SAS) for reference
      contentType: { type: String },       // MIME type
      size: { type: Number },              // bytes
      type: { type: String, enum: ['document', 'image'], default: 'document' },
      uploadedAt: { type: Date, default: Date.now }
    }
  ]
  ,
  customFields: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  schemaAssignments: {
    type: [SchemaAssignmentSchema],
    default: []
  }

}, { timestamps: true });

// Mentés előtt: ha hiányzik a tenantId, kitöltjük a CreatedBy user tenantId-jával (company kivezetve)
SiteSchema.pre('save', async function (next) {
    try {
        const user = await mongoose.model('User').findById(this.CreatedBy).select('tenantId');
        if (!user) {
            return next(new Error('Invalid CreatedBy user'));
        }

        // Fill tenantId if missing
        if (!this.tenantId && user.tenantId) {
            this.tenantId = user.tenantId;
        }

        next();
    } catch (error) {
        next(error);
    }
});

module.exports = mongoose.model('Site', SiteSchema);
