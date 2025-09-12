const Conversation = require('../models/conversation');

exports.getStatistics = async (req, res) => {
  try {
    console.log('Starting getStatistics (tenant-scoped) ...');

    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      console.error('Missing tenantId in auth scope.');
      return res.status(400).json({ error: 'Missing tenantId in auth' });
    }

    // Tenant-szűrt lekérdezés – nincs szükség company-populálásra
    const conversations = await Conversation.find({ tenantId }).select('messages');

    console.log(`Conversations retrieved for tenant=${tenantId}: ${conversations.length}`);

    const categoryCount = {};
    let totalRating = 0;
    let totalMessagesWithRating = 0;
    const categoryRatings = {};

    conversations.forEach((conversation) => {
      let lastUserCategory = null;

      (conversation.messages || []).forEach((message) => {
        if (message.role === 'user' && message.category) {
          lastUserCategory = message.category;
          categoryCount[message.category] = (categoryCount[message.category] || 0) + 1;
        }

        if (message.role === 'assistant' && message.rating !== null && message.rating !== undefined) {
          totalRating += message.rating;
          totalMessagesWithRating += 1;

          if (lastUserCategory) {
            if (!categoryRatings[lastUserCategory]) {
              categoryRatings[lastUserCategory] = { totalRating: 0, count: 0 };
            }
            categoryRatings[lastUserCategory].totalRating += message.rating;
            categoryRatings[lastUserCategory].count += 1;
          }
        }
      });
    });

    const globalAverageRating = totalMessagesWithRating
      ? Number((totalRating / totalMessagesWithRating).toFixed(2))
      : 0;

    const categoryAverages = {};
    for (const category in categoryRatings) {
      if (categoryRatings[category].count > 0) {
        categoryAverages[category] = Number(
          (categoryRatings[category].totalRating / categoryRatings[category].count).toFixed(2)
        );
      } else {
        categoryAverages[category] = 0;
      }
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