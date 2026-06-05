const mongoose = require('mongoose');

const ConversationStatsSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, unique: true },
    threadId: { type: String, required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    categoryCounts: { type: Map, of: Number, default: {} },
    ratingCount: { type: Number, default: 0 },
    ratingTotal: { type: Number, default: 0 },
    categoryRatingCounts: { type: Map, of: Number, default: {} },
    categoryRatingTotals: { type: Map, of: Number, default: {} }
  },
  { timestamps: true }
);

ConversationStatsSchema.index({ tenantId: 1, updatedAt: -1 });

module.exports = mongoose.model('ConversationStats', ConversationStatsSchema);
