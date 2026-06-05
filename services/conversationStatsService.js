const ConversationStats = require('../models/conversationStats');

function findPreviousUserCategory(messages, assistantIndex) {
  if (!Array.isArray(messages)) return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user') return msg.category || null;
  }
  return null;
}

function attachAssistantRatingCategory(messages, assistantIndex) {
  if (!Array.isArray(messages)) return null;
  const msg = messages[assistantIndex];
  if (!msg || msg.role !== 'assistant' || msg.rating == null) return null;
  const category = findPreviousUserCategory(messages, assistantIndex);
  if (category) {
    msg.assistantRatingCategory = category;
  } else {
    msg.assistantRatingCategory = undefined;
  }
  return category;
}

function incMap(map, key, by = 1) {
  if (!key) return;
  map.set(key, Number(map.get(key) || 0) + Number(by || 0));
}

function calculateConversationStats(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const categoryCounts = new Map();
  const categoryRatingCounts = new Map();
  const categoryRatingTotals = new Map();
  let ratingCount = 0;
  let ratingTotal = 0;

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'user') {
      const category = String(msg.category || '').trim();
      if (category) incMap(categoryCounts, category, 1);
      continue;
    }
    if (msg.role === 'assistant' && typeof msg.rating === 'number' && Number.isFinite(msg.rating)) {
      ratingCount += 1;
      ratingTotal += Number(msg.rating);
      const category = String(msg.assistantRatingCategory || '').trim();
      if (category) {
        incMap(categoryRatingCounts, category, 1);
        incMap(categoryRatingTotals, category, Number(msg.rating));
      }
    }
  }

  return { categoryCounts, ratingCount, ratingTotal, categoryRatingCounts, categoryRatingTotals };
}

async function syncConversationStats(conversation) {
  if (!conversation?._id || !conversation?.tenantId || !conversation?.threadId) return;
  const stats = calculateConversationStats(conversation);
  await ConversationStats.updateOne(
    { conversationId: conversation._id },
    {
      $set: {
        conversationId: conversation._id,
        threadId: conversation.threadId,
        tenantId: conversation.tenantId,
        categoryCounts: Object.fromEntries(stats.categoryCounts),
        ratingCount: stats.ratingCount,
        ratingTotal: stats.ratingTotal,
        categoryRatingCounts: Object.fromEntries(stats.categoryRatingCounts),
        categoryRatingTotals: Object.fromEntries(stats.categoryRatingTotals)
      }
    },
    { upsert: true }
  );
}

async function deleteConversationStats(conversation) {
  if (!conversation?._id) return;
  await ConversationStats.deleteOne({ conversationId: conversation._id });
}

async function getTenantStatistics(tenantId) {
  const rows = await ConversationStats.find({ tenantId })
    .select('categoryCounts ratingCount ratingTotal categoryRatingCounts categoryRatingTotals')
    .lean();

  const categoryCount = {};
  const categoryRatingCounts = {};
  const categoryRatingTotals = {};
  let totalMessagesWithRating = 0;
  let totalRating = 0;

  for (const row of rows || []) {
    for (const [key, count] of Object.entries(row.categoryCounts || {})) {
      categoryCount[key] = Number(categoryCount[key] || 0) + Number(count || 0);
    }
    totalMessagesWithRating += Number(row.ratingCount || 0);
    totalRating += Number(row.ratingTotal || 0);
    for (const [key, count] of Object.entries(row.categoryRatingCounts || {})) {
      categoryRatingCounts[key] = Number(categoryRatingCounts[key] || 0) + Number(count || 0);
    }
    for (const [key, total] of Object.entries(row.categoryRatingTotals || {})) {
      categoryRatingTotals[key] = Number(categoryRatingTotals[key] || 0) + Number(total || 0);
    }
  }

  const categoryAverages = {};
  for (const [key, count] of Object.entries(categoryRatingCounts)) {
    categoryAverages[key] = count
      ? Number((Number(categoryRatingTotals[key] || 0) / Number(count)).toFixed(2))
      : 0;
  }

  return {
    categoryCount,
    globalAverageRating: totalMessagesWithRating
      ? Number((totalRating / totalMessagesWithRating).toFixed(2))
      : 0,
    categoryAverages,
    sourceConversationStats: rows.length
  };
}

module.exports = {
  attachAssistantRatingCategory,
  calculateConversationStats,
  deleteConversationStats,
  findPreviousUserCategory,
  getTenantStatistics,
  syncConversationStats
};
