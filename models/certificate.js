const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
  scheme: { type: String },
  certNo: { type: String, required: true, unique: true },
  status: { type: String },
  issueDate: { type: String },
  applicant: { type: String },
  equipment: { type: String },
  manufacturer: { type: String },
  exmarking: { type: String },
  protection: { type: String },
  xcondition: { type: Boolean },
  specCondition: { type: String },
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  fileId: { type: String }, // 🔹 OneDrive fájl ID mentése
  uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Certificate', CertificateSchema);