// models/downloadQuota.js
const mongoose = require('mongoose');

const DownloadQuotaSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  ymd:    { type: String, required: true, index: true }, // YYYY-MM-DD
  count:  { type: Number, default: 0, min: 0 }
}, { timestamps: true });

DownloadQuotaSchema.index({ userId: 1, ymd: 1 }, { unique: true });

module.exports = mongoose.model('DownloadQuota', DownloadQuotaSchema);