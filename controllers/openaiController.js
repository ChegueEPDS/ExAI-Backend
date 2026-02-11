/**********************************************************************************/ 
/*** Az OpenAI beállítások lekérdezése, és módosítása. Asszisztens választása a userhez ***/
/**********************************************************************************/

const axios = require('axios');
const logger = require('../config/logger');
const User = require('../models/user'); // Felhasználói modell
const fs = require('fs');
const FormData = require('form-data');
const { resolveAssistantContext } = require('../services/assistantResolver');

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

async function resolveAssistantIdOrThrow(tenantId) {
  const { assistantId } = await resolveAssistantContext({ tenantId, logTag: 'INSTR' });
  if (!assistantId) {
    throw new Error('ASSISTANT_ID not configured (no tenant override and no default).');
  }
  return assistantId;
}

// 📥 Fájlok listázása a vector store-ból – névvel együtt
// 📥 Fájlok listázása a vector store-ból – LAPOZÁSSAL (20/db), visszafelé kompatibilisen
exports.listAssistantFiles = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('tenantId');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantIdOrThrow(tenantId);
    logger.info(`Vector store list – assistant: ${assistantId} (tenant=${tenantId})`);

    const vectorStoreId = await getVectorStoreId(assistantId);
    if (!vectorStoreId) {
      return res.status(404).json({ error: 'Nincs vector store társítva az asszisztenshez.' });
    }

    // --- Lapozó beállítások (20/db) ---
    const PAGE_SIZE = 20;
    const order = (String(req.query.order || 'desc').toLowerCase() === 'asc') ? 'asc' : 'desc';

    // Két működési mód:
    // 1) Paged mód: ha van page / after / before => csak 1 oldalt ad vissza, meta adatokkal
    // 2) Legacy (no params): összes oldalt összegyűjti és sima tömböt ad vissza (visszafelé kompatibilis)
    const hasPagingParam = !!(req.query.page || req.query.after || req.query.before || req.query.paged);

    // ---- Helper: kérjünk egy OLDALT az OpenAI API-tól ----
    async function fetchOnePage(opts = {}) {
      const params = { limit: PAGE_SIZE, order };
      if (opts.after) params.after = opts.after;
      if (opts.before) params.before = opts.before;

      const resp = await axios.get(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
        {
          params,
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      const { data, has_more, first_id, last_id } = resp.data || {};
      return { items: data || [], has_more: !!has_more, first_id: first_id || null, last_id: last_id || null };
    }

    // ---- Helper: feloldjuk a fájlnevet/bytes-t a /files/{id} végponttal ----
    async function enrich(items) {
      return Promise.all(
        (items || []).map(async (file) => {
          try {
            const detailRes = await axios.get(`https://api.openai.com/v1/files/${file.id}`, {
              headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
            });
            return {
              id: file.id,
              filename: detailRes.data.filename,
              status: detailRes.data.status,
              bytes: detailRes.data.bytes,
              created_at: file.created_at
            };
          } catch (e) {
            logger.warn(`Nem sikerült lekérni a fájl részleteit: ${file.id}`);
            return {
              id: file.id,
              filename: file.filename || '(unknown)',
              status: file.status || 'unknown',
              bytes: file.bytes || 0,
              created_at: file.created_at
            };
          }
        })
      );
    }

    if (hasPagingParam) {
      // ======= 1) PAGED mód =======
      const page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
      const afterQP = req.query.after ? String(req.query.after) : null;
      const beforeQP = req.query.before ? String(req.query.before) : null;

      let cursorAfter = afterQP;
      let cursorBefore = beforeQP;

      // Ha page számot kaptunk (és nincs explicit after/before), akkor "átlépkedünk" addig a page-ig
      if (!cursorAfter && !cursorBefore && page > 1) {
        let tmpAfter = null;
        let hasMore = true;
        for (let p = 1; p < page && hasMore; p++) {
          const pg = await fetchOnePage({ after: tmpAfter });
          hasMore = pg.has_more;
          tmpAfter = pg.last_id || null;
          if (!tmpAfter) break;
        }
        cursorAfter = tmpAfter;
      }

      const { items, has_more, first_id, last_id } = await fetchOnePage({ after: cursorAfter, before: cursorBefore });
      const detailed = await enrich(items);

      return res.status(200).json({
        items: detailed,
        paging: {
          page,
          pageSize: PAGE_SIZE,
          order,
          has_more,
          first_id,
          last_id,
          next_after: last_id || null,
          prev_before: first_id || null
        }
      });
    }

    // ======= 2) LEGACY mód (nincs query param) – ÖSSZES OLDAL LEHÚZÁSA =======
    const MAX_PAGES = parseInt(process.env.OPENAI_VS_MAX_PAGES || '50', 10);
    let all = [];
    let after = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const { items, has_more, last_id } = await fetchOnePage({ after });
      all = all.concat(items || []);
      if (!has_more || !last_id) break;
      after = last_id;
    }

    const detailedAll = await enrich(all);
    return res.status(200).json(detailedAll);
  } catch (err) {
    logger.error('❌ Fájlok listázási hiba:', err?.response?.data || err?.message || err);
    res.status(500).json({ error: 'Nem sikerült lekérni a fájlokat.' });
  }
};

// 📤 Fájl feltöltése és hozzárendelése a vector store-hoz
exports.uploadAssistantFile = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('tenantId');
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található.' });

    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    const assistantId = await resolveAssistantIdOrThrow(tenantId);
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

    res.status(201).json({ message: 'Fájl sikeresen feltöltve és hozzárendelve.', fileId, vectorStoreId });
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
    const assistantId = await resolveAssistantIdOrThrow(tenantId);
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
    const assistantId = await resolveAssistantIdOrThrow(tenantId);
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
    const assistantId = await resolveAssistantIdOrThrow(tenantId);
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
