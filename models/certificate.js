const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
  certNo: { type: String, required: true, unique: true },
  equipment: { type: String },
  manufacturer: { type: String },
  exmarking: { type: String },
  xcondition: { type: Boolean },
  specCondition: { type: String },
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Certificate', CertificateSchema);