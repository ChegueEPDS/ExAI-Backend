/******************************************************************************************/ 
/*** Az OpenAI beállítások lekérdezése, és módosítása. Asszisztens választása a userhez ***/
/******************************************************************************************/

const axios = require('axios');
const logger = require('../config/logger');
const assistants = require('../config/assistants');
const User = require('../models/user'); // Felhasználói modell
const fs = require('fs');
const FormData = require('form-data');

// Segédfüggvény: asszisztenshez tartozó vector store ID lekérése
async function getVectorStoreId(assistantId) {
  const response = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'assistants=v2'
    }
  });
  return response.data.tool_resources?.file_search?.vector_store_ids?.[0];
}

// 📥 Fájlok listázása a vector store-ból – névvel együtt
exports.listAssistantFiles = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('company');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const assistantId = assistants[user.company] || assistants['default'];
    const vectorStoreId = await getVectorStoreId(assistantId);
    if (!vectorStoreId) return res.status(404).json({ error: 'Nincs vector store társítva az asszisztenshez.' });

    // Alap fájllista lekérése
    const fileRes = await axios.get(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2'
      }
    });

    const files = fileRes.data.data;

    // Minden fájlhoz lekérjük a nevét is
    const detailedFiles = await Promise.all(
      files.map(async (file) => {
        try {
          const detailRes = await axios.get(`https://api.openai.com/v1/files/${file.id}`, {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
            }
          });
          return {
            id: file.id,
            filename: detailRes.data.filename,
            status: detailRes.data.status,
            bytes: detailRes.data.bytes,
            created_at: file.created_at 
          };
        } catch (err) {
          logger.warn(`Nem sikerült lekérni a fájl részleteit: ${file.id}`);
          return file; // visszatér az alap ID-val, ha nem sikerül
        }
      })
    );

    res.status(200).json(detailedFiles);
  } catch (err) {
    logger.error('❌ Fájlok listázási hiba:', err.message);
    res.status(500).json({ error: 'Nem sikerült lekérni a fájlokat.' });
  }
};

// 📤 Fájl feltöltése és hozzárendelése a vector store-hoz
exports.uploadAssistantFile = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('company');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const assistantId = assistants[user.company] || assistants['default'];
    const vectorStoreId = await getVectorStoreId(assistantId);
    if (!vectorStoreId) return res.status(404).json({ error: 'Nincs vector store társítva az asszisztenshez.' });

    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ error: 'Nem érkezett fájl a kérésben vagy hiányzik az útvonal.' });

    const form = new FormData();
    form.append('purpose', 'assistants'); // Ez előzze meg a fájlt
    form.append('file', fs.createReadStream(file.path), file.originalname);

    const uploadRes = await axios.post('https://api.openai.com/v1/files', form, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity // nagy fájlokhoz is engedélyezve
    });

    const fileId = uploadRes.data.id;

    await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id: fileId },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    try {
      fs.unlinkSync(file.path);
      logger.info(`Fájl sikeresen törölve: ${file.path}`);
    } catch (err) {
      logger.warn(`Nem sikerült törölni a feltöltött fájlt: ${file.path}`);
    }

    res.status(201).json({ message: 'Fájl sikeresen feltöltve és hozzárendelve.', fileId });
  } catch (err) {
    logger.error('❌ Fájl feltöltési hiba:', err.message);
    logger.error('❌ Stacktrace:', err);
    res.status(500).json({ error: 'Nem sikerült feltölteni a fájlt.' });
  }
};

// 📤 Fájl törlése a vector store-ból és az OpenAI fájltárból
exports.deleteAssistantFile = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('company');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const assistantId = assistants[user.company] || assistants['default'];
    const vectorStoreId = await getVectorStoreId(assistantId);
    if (!vectorStoreId) return res.status(404).json({ error: 'Nincs vector store társítva az asszisztenshez.' });

    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ error: 'Hiányzó fileId paraméter.' });

    // 1️⃣ Fájl törlése a vector store-ból
    await axios.delete(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${fileId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    // 2️⃣ Fájl törlése az OpenAI fájltárból
    await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });

    res.status(200).json({ message: 'Fájl sikeresen törölve.' });
  } catch (err) {
    logger.error('❌ Fájl törlési hiba:', err.message);
    res.status(500).json({ error: 'Nem sikerült törölni a fájlt.' });
  }
};

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