/**********************************************************************************/ 
/*** Az OpenAI beállítások lekérdezése, és módosítása. Asszisztens választása a userhez ***/
/**********************************************************************************/

const axios = require('axios');
const logger = require('../config/logger');
const assistants = require('../config/assistants');
const User = require('../models/user'); // Felhasználói modell
const fs = require('fs');
const FormData = require('form-data');
const Tenant = require('../models/tenant');

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

/**
 * Resolve assistant ID with priority: tenant → default
 * (company has been removed)
 */
async function resolveAssistantId(tenantId) {
    try {
      logger.debug('[ASSISTANT PICK][INSTR] incoming tenantId:', String(tenantId || ''));
      // 1) közvetlen ID mapping (ha használsz ilyet)
      if (assistants?.byTenantId && tenantId && assistants.byTenantId[String(tenantId)]) {
        const id = assistants.byTenantId[String(tenantId)];
        logger.debug('[ASSISTANT PICK][INSTR] byTenantId hit:', id);
        return id;
      }
      // 2) tenant name -> byTenant
      if (tenantId && assistants?.byTenant) {
        const t = await Tenant.findById(tenantId).select('name');
        logger.debug('[ASSISTANT PICK][INSTR] tenant doc:', t ? { _id: t._id, name: t.name } : null);
        const key = String(t?.name || '').toLowerCase();
        const hit = key && assistants.byTenant[key];
        logger.debug('[ASSISTANT PICK][INSTR] tenantKey:', key, 'hit:', !!hit);
        if (hit) return hit;
      }
      const def = assistants.default || assistants['default'];
      logger.debug('[ASSISTANT PICK][INSTR] fallback default:', def);
      return def;
    } catch (e) {
      logger.warn('[ASSISTANT PICK][INSTR] error, falling back to default:', e?.message);
      return assistants.default || assistants['default'];
    }
  }

// 📥 Fájlok listázása a vector store-ból – névvel együtt
exports.listAssistantFiles = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('tenantId');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantId(tenantId);
    logger.info(`Vector store list – assistant: ${assistantId} (tenant=${tenantId})`);

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
    const user = await User.findById(req.userId).select('tenantId');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantId(tenantId);
    logger.info(`Vector store upload – assistant: ${assistantId} (tenant=${tenantId})`);

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
    const user = await User.findById(req.userId).select('tenantId');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantId(tenantId);
    logger.info(`Vector store delete – assistant: ${assistantId} (tenant=${tenantId})`);

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
    const user = await User.findById(userId).select('tenantId');
    if (!user) {
      logger.error('Felhasználó nem található.');
      return res.status(404).json({ error: 'Felhasználó nem található.' });
    }

    // Az asszisztens azonosító kiválasztása tenant alapján
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantId(tenantId);
    logger.info(`Lekérdezett asszisztens ID: ${assistantId} (Tenant: ${tenantId})`);

    // OpenAI API hívás az asszisztens utasításaiért
    const response = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });

    // Asszisztens teljes objektum a válaszból
    const asst = response.data;
    logger.info('Asszisztens info lekérdezve:', { id: asst.id, name: asst.name, model: asst.model });

    // Csak a frontend által elvárt mezőket adjuk vissza
    res.status(200).json({
      name: asst.name || '',
      model: asst.model || '',
      instructions: asst.instructions || '',
      temperature: typeof asst.temperature === 'number' ? asst.temperature : 1,
      top_p: typeof asst.top_p === 'number' ? asst.top_p : 1
    });
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

exports.updateAssistantConfig = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      logger.error('Hiányzó userId a kérésből.');
      return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
    }

    const { instructions, model, temperature, top_p } = req.body;

    // Normalizáljuk az esetleges human label model értékeket API-kompatibilis ID-vá
    const modelMap = {
      'GPT 4.1': 'gpt-4.1',
      'GPT 4.1 mini': 'gpt-4.1-mini',
      'GPT 4.1 nano': 'gpt-4.1-nano',
      'GPT 4o': 'gpt-4o',
      'GPT 4o mini': 'gpt-4o-mini',
      'o3 mini': 'o3-mini',
      'o1': 'o1',
      'GPT 4': 'gpt-4',
      'GPT 4 turbo': 'gpt-4-turbo'
    };
    const normalizedModel = (typeof model === 'string' && modelMap[model]) ? modelMap[model] : model;

    // Felhasználói adatok lekérése az adatbázisból
    const user = await User.findById(userId).select('tenantId');
    if (!user) {
      logger.error('Felhasználó nem található.');
      return res.status(404).json({ error: 'Felhasználó nem található.' });
    }

    // Az asszisztens azonosító kiválasztása tenant alapján
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantId(tenantId);
    logger.info(`Asszisztens konfiguráció frissítése – assistant: ${assistantId} (tenant=${tenantId})`);

    // Összeállítjuk a frissítendő adatokat csak a megadott mezőkkel
    const payload = {};
    if (instructions !== undefined) payload.instructions = instructions;
    if (normalizedModel !== undefined) payload.model = normalizedModel;
    if (temperature !== undefined) payload.temperature = temperature;
    if (top_p !== undefined) payload.top_p = top_p;

    const response = await axios.post(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    res.status(200).json(response.data);
  } catch (error) {
    if (error.response) {
      logger.error('OpenAI API frissítési hiba:', {
        status: error.response.status,
        data: error.response.data,
      });
      res.status(error.response.status).json({
        error: error.response.data.error || 'Hiba történt az API frissítése során.',
      });
    } else if (error.request) {
      logger.error('OpenAI API frissítés nem érhető el:', error.request);
      res.status(500).json({ error: 'Az OpenAI API nem érhető el.' });
    } else {
      logger.error('Kérés beállítási hiba frissítéskor:', error.message);
      res.status(500).json({ error: 'Belső szerver hiba történt.' });
    }
  }
};