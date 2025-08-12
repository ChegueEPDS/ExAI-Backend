const mongoose = require('mongoose');

const UploadSessionSchema = new mongoose.Schema({
  uploadId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  originalFileNames: [String],
  status: { type: String, enum: ['processing', 'done', 'error'], default: 'processing' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }
});

module.exports = mongoose.model('UploadSession', UploadSessionSchema);
