const Conversation = require('../models/conversation');


exports.getStatistics = async (req, res) => {
  try {
    console.log('Starting getStatistics function...');

    if (!req.user || !req.user.company) {
      console.error('User company information is missing.');
      return res.status(400).json({ error: 'User company information is missing' });
    }

    const loggedInUserCompany = req.user.company;
    console.log(`Logged in user's company: ${loggedInUserCompany}`);

    const conversations = await Conversation.find()
  .populate({
    path: 'userId',
    select: 'company',
  })
  .then((results) =>
    results.filter((conversation) => conversation.userId && conversation.userId.company === loggedInUserCompany)
  );

    console.log(`Number of conversations retrieved: ${conversations.length}`);

    const categoryCount = {};
    let totalRating = 0;
    let totalMessagesWithRating = 0;
    const categoryRatings = {};

    conversations.forEach((conversation) => {
      let lastUserCategory = null;

      conversation.messages.forEach((message) => {
        if (message.role === 'user' && message.category) {
          lastUserCategory = message.category;
          categoryCount[message.category] = (categoryCount[message.category] || 0) + 1;
        }

        if (message.role === 'assistant' && message.rating !== null) {
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
      ? (totalRating / totalMessagesWithRating).toFixed(2)
      : 0;

    const categoryAverages = {};
    for (const category in categoryRatings) {
      if (categoryRatings[category].count > 0) {
        categoryAverages[category] = (
          categoryRatings[category].totalRating / categoryRatings[category].count
        ).toFixed(2);
      } else {
        categoryAverages[category] = 0;
      }
    }

    // JSON naplózása a konzolra
    console.log('Category Count:', JSON.stringify(categoryCount, null, 2));
    console.log('Global Average Rating:', globalAverageRating);
    console.log('Category Averages:', JSON.stringify(categoryAverages, null, 2));

    // JSON válasz küldése
    res.json({
      categoryCount,
      globalAverageRating,
      categoryAverages,
    });
  } catch (error) {
    console.error('Error in getStatistics:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
};