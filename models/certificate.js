const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
    certNo: { type: String, required: true, unique: true },
    scheme: { type: String },
    status: { type: String },
    issueDate: { type: String },
    applicant: { type: String },
    protection: { type: String },
    equipment: { type: String },
    manufacturer: { type: String },
    exmarking: { type: String },
    fileName: { type: String },
    fileUrl: { type: String }, // PDF file URL
    fileId: { type: String },  // PDF file ID
    docxUrl: { type: String }, // DOCX file URL
    docxId: { type: String },  // DOCX file ID
    folderId: { type: String },  // OneDrive folder ID
    folderUrl: { type: String }, // 🔹 OneDrive folder URL (NEW)
    xcondition: { type: Boolean, default: false },
    specCondition: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Certificate', CertificateSchema);