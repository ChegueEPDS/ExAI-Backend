const mongoose = require('mongoose');

const EmailConsentLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, required: true, lowercase: true, index: true },
  category: { type: String, enum: ['useful_information', 'newsletter'], required: true, index: true },
  previousEnabled: { type: Boolean, required: true },
  enabled: { type: Boolean, required: true },
  source: { type: String, enum: ['settings', 'brevo_webhook', 'migration', 'registration', 'sync_retry'], required: true, index: true },
  language: { type: String, enum: ['en', 'hu'], default: 'en' },
  brevoListIds: { type: [Number], default: [] },
  syncStatus: { type: String, enum: ['synced', 'pending', 'failed', 'not_required'], default: 'pending' },
  syncError: { type: String, default: '' },
  requestId: { type: String, default: '' },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: true });

EmailConsentLogSchema.index({ userId: 1, category: 1, createdAt: -1 });

module.exports = mongoose.models.EmailConsentLog || mongoose.model('EmailConsentLog', EmailConsentLogSchema);
