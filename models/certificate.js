const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
  certNo: { type: String, required: true, unique: true },
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  xcondition: { type: Boolean },
  specCondition: { type: String }
});

module.exports = mongoose.model('Certificate', CertificateSchema);