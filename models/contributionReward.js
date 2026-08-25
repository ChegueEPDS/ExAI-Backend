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
      enum: ['pending', 'issued', 'emailed', 'redeemed', 'expired', 'failed'],
      default: 'pending',
      index: true,
    },
    lastError: { type: String, default: '' },
    emailedAt: { type: Date, default: null },
    initialEmailSentAt: { type: Date, default: null },
    reminderSentAt: { type: Date, default: null },
    expiryReminderSentAt: { type: Date, default: null },
    redeemedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    stripeCheckoutSessionId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    lastStripeSyncAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ContributionRewardSchema.index({ userId: 1, milestone: 1 }, { unique: true, name: 'uniq_user_milestone' });
ContributionRewardSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('ContributionReward', ContributionRewardSchema);
