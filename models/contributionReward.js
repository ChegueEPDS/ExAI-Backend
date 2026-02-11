// models/contributionReward.js
const mongoose = require('mongoose');

const ContributionRewardSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },

    // 20, 40, 60, ...
    milestone: { type: Number, required: true, min: 1, index: true },

    // Stripe artifacts
    stripeCustomerId: { type: String },
    stripeCouponId: { type: String },
    stripePromotionCodeId: { type: String },
    promoCode: { type: String },
    expiresAt: { type: Date },

    status: {
      type: String,
      enum: ['pending', 'issued', 'emailed', 'failed'],
      default: 'pending',
      index: true,
    },
    lastError: { type: String, default: '' },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ContributionRewardSchema.index({ userId: 1, milestone: 1 }, { unique: true, name: 'uniq_user_milestone' });

module.exports = mongoose.model('ContributionReward', ContributionRewardSchema);

