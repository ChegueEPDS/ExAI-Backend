/******************************************************************************************/ 
/*** Az OpenAI beállítások lekérdezése, és módosítása. Asszisztens választása a userhez ***/
/******************************************************************************************/

const axios = require('axios');
const logger = require('../config/logger');
const assistants = require('../config/assistants');
const User = require('../models/user'); // Felhasználói modell

// Lekérdezi az asszisztens utasításait
exports.getAssistantInstructions = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      logger.error('Hiányzó userId a kérésből.');
      return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
    }

    // Felhasználói adatok lekérése az adatbázisból
    const user = await User.findById(userId).select('company');
    if (!user) {
      logger.error('Felhasználó nem található.');
      return res.status(404).json({ error: 'Felhasználó nem található.' });
    }

    // Az asszisztens azonosító kiválasztása a company alapján
    const company = user.company;
    const assistantId = assistants[company] || assistants['default'];
    logger.info(`Lekérdezett asszisztens ID: ${assistantId} (Company: ${company})`);

    // OpenAI API hívás az asszisztens utasításaiért
    const response = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });

    // Az utasítások a válaszból
    const instructions = response.data;
    logger.info('Asszisztens info lekérdezve:', instructions);

    // JSON formában küldi vissza a kliensnek
    res.status(200).json(instructions);
  } catch (error) {
    if (error.response) {
      // Az API válaszolt, de hibás státuszkódot adott
      logger.error('OpenAI API válasz hiba:', {
        status: error.response.status,
        data: error.response.data,
      });
      res.status(error.response.status).json({
        error: error.response.data.error || 'Hiba történt az API lekérdezése során.',
      });
    } else if (error.request) {
      // A kérés elment, de nem érkezett válasz
      logger.error('OpenAI API válasz nem érkezett:', error.request);
      res.status(500).json({ error: 'Az OpenAI API nem érhető el.' });
    } else {
      // Valami más hiba történt a kérés beállításában
      logger.error('Kérés beállítási hiba:', error.message);
      res.status(500).json({ error: 'Belső szerver hiba történt.' });
    }
  }
};