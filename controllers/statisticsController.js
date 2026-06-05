const Conversation = require('../models/conversation');
const mongoose = require('mongoose');
const { getTenantStatistics } = require('../services/conversationStatsService');

exports.getStatistics = async (req, res) => {
  try {
    console.log('Starting getStatistics (tenant-scoped) ...');

    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      console.error('Missing tenantId in auth scope.');
      return res.status(400).json({ error: 'Missing tenantId in auth' });
    }

    const tenantMatchId = mongoose.Types.ObjectId.isValid(String(tenantId))
      ? new mongoose.Types.ObjectId(String(tenantId))
      : tenantId;

    const denormalized = await getTenantStatistics(tenantMatchId);
    const conversationCount = await Conversation.countDocuments({ tenantId: tenantMatchId });
    if (conversationCount > 0 && denormalized.sourceConversationStats >= conversationCount) {
      return res.json({
        tenantId,
        categoryCount: denormalized.categoryCount,
        globalAverageRating: denormalized.globalAverageRating,
        categoryAverages: denormalized.categoryAverages
      });
    }

    const [categoryRows, ratingRows, categoryRatingRows] = await Promise.all([
      Conversation.aggregate([
        { $match: { tenantId: tenantMatchId } },
        { $unwind: '$messages' },
        {
          $match: {
            'messages.role': 'user',
            'messages.category': { $exists: true, $nin: [null, ''] }
          }
        },
        { $group: { _id: '$messages.category', count: { $sum: 1 } } }
      ]),
      Conversation.aggregate([
        { $match: { tenantId: tenantMatchId } },
        { $unwind: '$messages' },
        {
          $match: {
            'messages.role': 'assistant',
            'messages.rating': { $type: 'number' }
          }
        },
        {
          $group: {
            _id: null,
            totalRating: { $sum: '$messages.rating' },
            count: { $sum: 1 }
          }
        }
      ]),
      Conversation.aggregate([
        { $match: { tenantId: tenantMatchId } },
        { $unwind: '$messages' },
        {
          $match: {
            'messages.role': 'assistant',
            'messages.rating': { $type: 'number' },
            'messages.assistantRatingCategory': { $exists: true, $nin: [null, ''] }
          }
        },
        {
          $group: {
            _id: '$messages.assistantRatingCategory',
            totalRating: { $sum: '$messages.rating' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const categoryCount = Object.fromEntries(
      (categoryRows || []).map((row) => [row._id, Number(row.count || 0)])
    );
    const ratingAgg = ratingRows?.[0] || {};
    const totalRating = Number(ratingAgg.totalRating || 0);
    const totalMessagesWithRating = Number(ratingAgg.count || 0);

    const globalAverageRating = totalMessagesWithRating
      ? Number((totalRating / totalMessagesWithRating).toFixed(2))
      : 0;

    const categoryAverages = {};
    for (const row of categoryRatingRows || []) {
      const count = Number(row.count || 0);
      categoryAverages[row._id] = count
        ? Number((Number(row.totalRating || 0) / count).toFixed(2))
        : 0;
    }

    // Naplózás
    console.log('Category Count:', JSON.stringify(categoryCount, null, 2));
    console.log('Global Average Rating:', globalAverageRating);
    console.log('Category Averages:', JSON.stringify(categoryAverages, null, 2));

    // Válasz
    res.json({
      tenantId,
      categoryCount,
      globalAverageRating,
      categoryAverages,
    });
  } catch (error) {
    console.error('Error in getStatistics:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
};
