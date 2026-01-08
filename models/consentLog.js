const mongoose = require('mongoose');

const ConsentLogSchema = new mongoose.Schema(
  {
    consentId: { type: String, required: true, index: true },
    source: { type: String, default: 'web' }, // web | mobile | etc.
    policyVersion: { type: String, default: 'v1' },

    analytics: { type: String, enum: ['granted', 'denied'], required: true },
    marketing: { type: String, enum: ['granted', 'denied'], required: true },

    // Optional auth context (if user was logged in)
    userId: { type: String, default: null, index: true },
    tenantId: { type: String, default: null, index: true },
    tenantType: { type: String, default: null },
    plan: { type: String, default: null }, // free | pro | team

    pageUrl: { type: String, default: null },
  },
  { timestamps: true }
);

// Helps lookups by consentId+time
ConsentLogSchema.index({ consentId: 1, createdAt: -1 });

module.exports = mongoose.model('ConsentLog', ConsentLogSchema);

