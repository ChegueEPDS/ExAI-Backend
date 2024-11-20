// textProcessingMiddleware.js
const axios = require('axios');
const logger = require('../config/logger');

exports.processRecognizedText = async (req, res, next) => {
  try {
    const { recognizedText } = req.body;
    if (!recognizedText) {
      logger.error('Hiba: A recognizedText mező nem található a request body-ban.');
      return res.status(400).json({ error: 'Nincs feldolgozandó szöveg.' });
    }

    // Naplózzuk a feldolgozandó szöveget
    logger.info('Feldolgozandó szöveg:', recognizedText);

    // Ellenőrizzük, hogy van-e Authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      logger.error('No token provided in the request');
      return res.status(401).json({ error: 'No token provided' });
    }

    // User azonosító (feltételezve, hogy az 'authMiddleware' beállította)
    const userId = req.userId;

    if (!userId) {
      logger.error('Missing userId in the request');
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Küldés az OpenAI API-hoz vagy más külső feldolgozó végponthoz
    const response = await axios.post('/api/chat', {
      message: `Foglald táblázatban az alábbi adattáblán látható információkat és ha van több információd az eszközről a táradban akkor írd le amit tudsz a modellről: ${recognizedText}`,
      userId: userId, // A bejelentkezett felhasználó azonosítója
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader // Továbbítjuk a felhasználói tokent
      }
    });

    // Naplózzuk a sikeres választ
    logger.info('API válasz:', response.data);
    res.json(response.data);

  } catch (error) {
    logger.error('Hiba történt az API hívás során:');
    if (error.response) {
      logger.error('Szerver válasz hiba:', error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else if (error.request) {
      logger.error('Nincs válasz az API-tól:', error.request);
      res.status(500).json({ error: 'Nincs válasz az API-tól.' });
    } else {
      logger.error('Hiba történt a kérés elkészítésekor:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
};
