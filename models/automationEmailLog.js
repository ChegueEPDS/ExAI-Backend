const mongoose = require('mongoose');

const AutomationEmailLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
  type: { type: String, required: true, index: true },
  dedupeKey: { type: String, required: true },
  category: { type: String, enum: ['marketing', 'service'], default: 'marketing', index: true },
  status: { type: String, enum: ['queued', 'reserved', 'sent', 'failed', 'skipped'], default: 'reserved', index: true },
  availableAt: { type: Date, default: null, index: true },
  sentAt: { type: Date, default: null, index: true },
  lastError: { type: String, default: '' },
  meta: { type: Object, default: {} },
}, { timestamps: true });

AutomationEmailLogSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true, name: 'uniq_automation_email' });
AutomationEmailLogSchema.index({ status: 1, availableAt: 1 });

module.exports = mongoose.model('AutomationEmailLog', AutomationEmailLogSchema);
