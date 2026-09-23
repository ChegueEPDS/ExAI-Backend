// models/subscription.js
const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tier: { type: String, enum: ['free', 'pro', 'team'], required: true },
  seatsPurchased: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['active','trialing','incomplete','past_due','unpaid','canceled'],
    default: 'active'
  },

  // 🔹 Manuális licencekhez / ideiglenes hosszabbításhoz
  expiresAt: { type: Date },
}, { timestamps: true });

// Hasznos indexek
SubscriptionSchema.index({ tenantId: 1 });
SubscriptionSchema.index({ tenantId: 1, updatedAt: -1 });
SubscriptionSchema.index({ expiresAt: 1 });
SubscriptionSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
