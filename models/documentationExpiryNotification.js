const mongoose = require('mongoose');

const DocumentationExpiryNotificationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    documentationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Documentation', required: true, index: true },
    thresholdDays: { type: Number, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

DocumentationExpiryNotificationSchema.index(
  { tenantId: 1, documentationId: 1, thresholdDays: 1, userId: 1 },
  { unique: true }
);

module.exports = mongoose.models.DocumentationExpiryNotification || mongoose.model('DocumentationExpiryNotification', DocumentationExpiryNotificationSchema);
