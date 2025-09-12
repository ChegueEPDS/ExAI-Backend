const mongoose = require('mongoose');

const CompanyCertificateLinkSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true, required: true },
  certId: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', required: true },
  // opcionális meta:
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedAt: { type: Date, default: Date.now },
  note: { type: String },
  tags: { type: [String], default: [] }
}, { timestamps: true });

// Egy tenant ugyanazt a tanúsítványt csak egyszer adoptálhatja
CompanyCertificateLinkSchema.index(
  { tenantId: 1, certId: 1 },
  { unique: true, name: 'uniq_tenant_cert_link' }
);

module.exports = mongoose.model('CompanyCertificateLink', CompanyCertificateLinkSchema);