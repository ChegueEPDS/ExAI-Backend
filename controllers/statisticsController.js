const Conversation = require('../models/conversation');
const User = require('../models/user'); // A felhasználó modell importálása

exports.getStatistics = async (req, res) => {
  try {
    if (!req.user || !req.user.company) {
      return res.status(400).json({ error: 'User company information is missing' });
    }
    // Bejelentkezett felhasználó company adatának lekérése
    const loggedInUserCompany = req.user.company;

    // Beszélgetések szűrése a kapcsolódó felhasználó company alapján
    const conversations = await Conversation.find()
      .populate({
        path: 'userId', // Kapcsolt felhasználó adatok betöltése
        select: 'company', // Csak a company mezőt töltjük be
      })
      .then((results) =>
        results.filter((conversation) => conversation.userId.company === loggedInUserCompany)
      );

    // Statisztikai adatok előkészítése
    const categoryCount = {};
    let totalRating = 0;
    let totalMessagesWithRating = 0;
    const categoryRatings = {};

    // Beszélgetések feldolgozása
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

    // Globális és kategóriánkénti átlagok kiszámítása
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

    // JSON válasz visszaadása
    res.json({
      categoryCount,
      globalAverageRating,
      categoryAverages,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
};