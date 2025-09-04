const mongoose = require('mongoose');

const CompanyCertificateLinkSchema = new mongoose.Schema({
  company: { type: String, required: true }, // pl. user.company
  certId: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', required: true },
  // opcionális meta:
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedAt: { type: Date, default: Date.now },
  note: { type: String },
  tags: { type: [String], default: [] }
}, { timestamps: true });

// Egy cég ugyanazt a tanúsítványt csak egyszer adoptálhatja
CompanyCertificateLinkSchema.index({ company: 1, certId: 1 }, { unique: true });

module.exports = mongoose.model('CompanyCertificateLink', CompanyCertificateLinkSchema);