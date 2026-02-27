const axios = require('axios');
const crypto = require('crypto');
const { body } = require('express-validator');
const multer = require('multer');
const logger = require('../config/logger');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const { fetchFromAzureSearch } = require('../helpers/azureSearchHelpers');

const { handleSendMessageStream } = require('../services/chatStreamService');

exports.sendMessageStream = (req, res) => handleSendMessageStream(req, res);

const { handleUploadAndAskStream } = require('../services/uploadAndAskService');

const upload = multer({ storage: multer.memoryStorage() });
exports.uploadMulter = upload;

exports.uploadAndAskStream = [
  upload.array('files', 10),
  (req, res) => handleUploadAndAskStream(req, res)
];

const { handleSendMessage } = require('../services/chatMessageService');

// Új beszélgetés indítása
exports.startNewConversation = async (req, res) => {
  try {
    const userId = req.userId;
    // We no longer create OpenAI Threads/Runs. The conversation id is generated and
    // the model state is chained via Responses API previous_response_id (store:true).
    const threadId = `c_${crypto.randomBytes(12).toString('hex')}`;

    // Internal project id used by governed chat + dataset ingestion.
    // Keep it opaque and stable for the lifetime of the conversation.
    const governedProjectId = `p_${crypto.randomBytes(8).toString('hex')}`;

    const newConversation = new Conversation({
      threadId,
      messages: [],
      userId,
      tenantId: req.scope?.tenantId || undefined,
      governedProjectId,
      lastResponseId: null,
    });

    await newConversation.save();
    logger.info('Új szál létrehozva:', threadId);

    res.status(200).json({ threadId, governedProjectId });
  } catch (error) {
    logger.error('Hiba az új szál létrehozása során:', error.message);
    res.status(500).json({ error: 'Nem sikerült új szálat létrehozni.' });
  }
};

exports.sendMessage = [
  body('message').isString().notEmpty().trim().escape(),
  body('threadId').isString().notEmpty().trim().escape(),
  (req, res) => handleSendMessage(req, res)
];


exports.rateMessage = async (req, res) => {
  const { threadId, messageIndex, rating } = req.body;

  try {
    const conversation = await Conversation.findOne({ threadId, userId: req.userId, tenantId: (req.scope?.tenantId || undefined) });

    if (!conversation) {
      return res.status(404).json({ error: 'A beszélgetés nem található.' });
    }

    if (conversation.messages[messageIndex]) {
      conversation.messages[messageIndex] = {
        ...conversation.messages[messageIndex]._doc,
        rating: rating
      };
      await conversation.save();
      return res.status(200).json({ message: 'Értékelés mentve.' });
    } else {
      return res.status(404).json({ error: 'Az üzenet nem található.' });
    }
  } catch (error) {
    logger.error('Hiba az értékelés mentése során:', error.message);
    return res.status(500).json({ error: 'Értékelés mentése sikertelen.' });
  }
};

// Visszajelzés mentése
exports.saveFeedback = async (req, res) => {
  const { threadId, messageIndex, comment, references } = req.body;

  try {
    const conversation = await Conversation.findOne({ threadId, userId: req.userId, tenantId: (req.scope?.tenantId || undefined) });
    if (!conversation) {
      return res.status(404).json({ error: 'A beszélgetés nem található.' });
    }

    if (conversation.messages[messageIndex]) {
      conversation.messages[messageIndex].feedback = {
        comment,
        references,
        submittedAt: new Date() // Beállítjuk a jelenlegi időpontot
      };
      await conversation.save();
      return res.status(200).json({ message: 'Visszajelzés mentve.' });
    } else {
      return res.status(404).json({ error: 'Az üzenet nem található.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'A visszajelzés mentése sikertelen.' });
  }
};

// Korábbi beszélgetések listázása
exports.getConversations = async (req, res) => {
  try {
    const userId = req.userId;  // Bejelentkezett felhasználó azonosítója
    const tenantId = req.scope?.tenantId || undefined;

    // Rendezés már a DB-ben: legújabbtól a legrégebbiig
    const conversations = await Conversation
      .find({ userId, tenantId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('threadId messages job hasBackgroundJob governedProjectId chatBackend standardExplorer updatedAt createdAt')
      .lean();

    const conversationList = conversations.map(c => ({
      threadId: c.threadId,
      messages: c.messages,
      job: c.job || null,
      hasBackgroundJob: !!c.hasBackgroundJob,
      governedProjectId: c.governedProjectId || null,
      chatBackend: c.chatBackend || 'normal',
      standardExplorer: c.standardExplorer || { enabled: false, standardRef: null },
      updatedAt: c.updatedAt,
    }));

    res.status(200).json(conversationList);  // Az összes beszélgetés visszaküldése
  } catch (error) {
    logger.error('Hiba a beszélgetések lekérése során:', error.message);
    res.status(500).json({ error: 'Váratlan hiba történt.' });
  }
};

// Enable Standard Explorer (tenant standard library) for a thread and pin a primary standard.
// POST /api/conversation/standard-explorer { threadId, standardRef }
exports.setStandardExplorer = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId || undefined;
    const userId = req.userId;
    const threadId = String(req.body?.threadId || '').trim();
    const standardRef = String(req.body?.standardRef || '').trim();
    const enabled = String(req.body?.enabled ?? 'true').trim().toLowerCase() !== 'false';

    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId is required' });
    if (enabled && !standardRef) return res.status(400).json({ ok: false, error: 'standardRef is required' });

    const conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) return res.status(404).json({ ok: false, error: 'not found' });

    conversation.standardExplorer = {
      enabled: !!enabled,
      standardRef: enabled ? standardRef : null,
    };
    // Standard explorer always routes to governed (standards-only retrieval).
    conversation.chatBackend = enabled ? 'governed' : (conversation.chatBackend || 'normal');
    await conversation.save();

    return res.json({
      ok: true,
      threadId: conversation.threadId,
      chatBackend: conversation.chatBackend,
      standardExplorer: conversation.standardExplorer,
    });
  } catch (e) {
    logger.error('standardExplorer.set.error', { message: e?.message });
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
};

// Korábbi beszélgetés betöltése
exports.getConversationById = async (req, res) => {
  const { threadId } = req.query;  // A szál ID-je a kérésből
  try {
    const conversation = await Conversation.findOne({ threadId, userId: req.userId, tenantId: (req.scope?.tenantId || undefined) });

    if (!conversation) {
      return res.status(404).json({ error: 'A megadott szál nem található vagy nem hozzáférhető.' });
    }

    res.status(200).json(conversation.messages);  // A beszélgetés üzeneteinek visszaküldése
  } catch (error) {
    logger.error('Hiba a beszélgetés betöltése során:', error.message);
    res.status(500).json({ error: 'Váratlan hiba történt.' });
  }
};

// Új keresés-válasz végpont, amely az Azure és OpenAI eredményeket használja
exports.searchAndRespond = async (req, res) => {
  try {
    const { query, threadId } = req.body;

    // Validáció
    if (!query || !threadId) {
      logger.error('Hiányzó adat: Kérdés vagy szál azonosító nincs megadva.', { query, threadId });
      return res.status(400).json({ error: 'A kérdés és a szál azonosítója kötelező.' });
    }

    const userToken = req.headers.authorization?.split(' ')[1];
    if (!userToken) {
      logger.error('Hiányzó JWT token.');
      return res.status(401).json({ error: 'Hiányzó token.' });
    }

    logger.info(`Keresési kérdés érkezett: ${query}`, { threadId });

    // 1. Azure AI Search hívása
    let azureResults;
    try {
      azureResults = await fetchFromAzureSearch(query);
      logger.info('Azure keresési találatok sikeresen fogadva.', { azureResults });
    } catch (azureError) {
      logger.error('Hiba az Azure AI Search hívása során:', {
        error: azureError.message,
        stack: azureError.stack,
        query,
      });
      throw new Error('Hiba történt az Azure keresés során.');
    }

    // 2. Kontextus előkészítése
    const combinedMessage = `
      Kérdés: ${query}
      Azure keresési találatok:
      ${JSON.stringify(azureResults, null, 2)}
    `;
    logger.info('Kontextus előkészítve a következő adatokkal.', { combinedMessage });

    // 3. Továbbítás a chat végpontnak
    const chatEndpoint = `${process.env.BASE_URL}/api/chat`;
    let sendMessageResponse;
    try {
      logger.info('Kimenő chat API kérés adatai:', {
        url: chatEndpoint,
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: { message: combinedMessage, threadId },
      });

      sendMessageResponse = await axios.post(chatEndpoint, {
        message: combinedMessage,
        threadId,
      }, {
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
      });

      logger.info('Chat végpont sikeresen válaszolt.', { responseData: sendMessageResponse.data });
    } catch (chatError) {
      logger.error('Hiba a chat végpont hívása során:', {
        error: chatError.message,
        stack: chatError.stack,
        response: chatError.response ? chatError.response.data : 'Nincs válasz adat',
        status: chatError.response ? chatError.response.status : 'Nincs státusz',
      });
      throw new Error('Hiba történt a chat végpont hívása során.');
    }

    // 4. Kliens válasz
    res.status(200).json(sendMessageResponse.data);
  } catch (error) {
    logger.error('Hiba a keresés-válasz folyamat során.', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Váratlan hiba történt.' });
  }
};
// ===== Delete conversation + cleanup resources =====
// DELETE /api/conversation/:threadId
exports.deleteConversation = async (req, res) => {
  try {
    const { threadId } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Hiányzó vagy érvénytelen JWT.' });
    }
    if (!threadId || typeof threadId !== 'string' || !threadId.trim()) {
      return res.status(400).json({ error: 'threadId kötelező.' });
    }

    // Resolve tenant similarly to other endpoints
    const user = await User.findById(userId).select('tenantId');
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    if (!tenantId) {
      return res.status(400).json({ error: 'Hiányzó tenant azonosító.' });
    }

    // Validate ownership
    const conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) {
      return res.status(404).json({ error: 'Beszélgetés nem található.' });
    }

    // --- Helpers (scoped) ---
    const safeDelete = async (fn) => {
      try { await fn(); }
      catch (e) { logger.warn('[DELETE][CLEANUP]', e?.response?.data || e?.message); }
    };

    // OpenAI thread cleanup removed: threadId is an internal conversation id (Responses API uses response ids).

    // Governed RAG cleanup (best-effort): delete all datasets + vectors + blobs under this conversation's internal projectId.
    await (async () => {
      const projectId = String(conversation.governedProjectId || '').trim();
      if (!projectId) return;
      try {
        logger.info('[DELETE][CLEANUP] governed project cleanup start', { tenantId: String(tenantId), projectId, threadId });
      } catch { }

      const Dataset = require('../models/dataset');
      const DatasetFile = require('../models/datasetFile');
      const DatasetRowChunk = require('../models/datasetRowChunk');
      const DatasetTableCell = require('../models/datasetTableCell');
      const DatasetDocChunk = require('../models/datasetDocChunk');
      const DatasetImageChunk = require('../models/datasetImageChunk');
      const DatasetDerivedMetric = require('../models/datasetDerivedMetric');
      const DatasetTableSchema = require('../models/datasetTableSchema');
      const azureBlob = require('../services/azureBlobService');
      const pinecone = require('../services/pineconeService');

      // 1) Pinecone vectors (scoped by tenant+project namespace)
      if (pinecone.isPineconeEnabled()) {
        const namespace = pinecone.resolveNamespace({ tenantId, projectId });
        // Most robust: wipe everything in this per-project namespace (works for serverless + pod indexes).
        const rAll = await pinecone.deleteAll({ namespace, bestEffort: true });
        if (rAll?.ok) {
          logger.info('[DELETE][CLEANUP] pinecone deleteAll done', { tenantId: String(tenantId), projectId: String(projectId), namespace });
        } else {
          logger.warn('[DELETE][CLEANUP] pinecone deleteAll failed (bestEffort)', { tenantId: String(tenantId), projectId: String(projectId), namespace, error: rAll?.error || 'unknown' });
        }

        // Fallback: delete by IDs (works for serverless + pod indexes). Then also try a filter delete
        // to clean up any legacy/orphan vectors (best-effort) in case deleteAll isn't supported by the environment.
        const batch = [];
        let deletedByIds = 0;
        const flush = async () => {
          if (!batch.length) return;
          const r = await pinecone.deleteByIds({ namespace, ids: batch.splice(0, batch.length), bestEffort: true });
          if (!r?.ok) {
            logger.warn('[DELETE][CLEANUP] pinecone deleteByIds failed (bestEffort)', { tenantId: String(tenantId), projectId: String(projectId), error: r?.error || 'unknown' });
            return;
          }
          deletedByIds += Number(r.deleted || 0);
        };

        const collectIds = async (Model, prefix) => {
          try {
            const cursor = Model.find({ tenantId, projectId }).select('_id').lean().cursor();
            for await (const doc of cursor) {
              const id = doc?._id ? String(doc._id) : '';
              if (!id) continue;
              batch.push(`${prefix}${id}`);
              if (batch.length >= 500) {
                await flush();
              }
            }
          } catch (e) {
            logger.warn('[DELETE][CLEANUP] pinecone id collection failed', { tenantId: String(tenantId), projectId: String(projectId), error: e?.message || String(e) });
          }
        };

        await collectIds(DatasetRowChunk, 'row:');
        await collectIds(DatasetDocChunk, 'doc:');
        await collectIds(DatasetImageChunk, 'img:');
        await flush();

        if (!rAll?.ok) {
          logger.info('[DELETE][CLEANUP] pinecone deleteByIds done', { tenantId: String(tenantId), projectId: String(projectId), namespace, deleted: deletedByIds });

          const rFilter = await pinecone.deleteByFilter({
            namespace,
            filter: { tenantId: String(tenantId), projectId: String(projectId) },
            bestEffort: true,
          });
          if (!rFilter?.ok) {
            logger.warn('[DELETE][CLEANUP] pinecone deleteByFilter failed (bestEffort)', { tenantId: String(tenantId), projectId: String(projectId), error: rFilter?.error || 'unknown' });
          }
        }
      }

      // 2) DB records
      await safeDelete(() => DatasetRowChunk.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetTableCell.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetDocChunk.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetImageChunk.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetDerivedMetric.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetTableSchema.deleteMany({ tenantId, projectId }));
      await safeDelete(() => DatasetFile.deleteMany({ tenantId, projectId }));
      await safeDelete(() => Dataset.deleteMany({ tenantId, projectId }));

      // 3) Blobs under datasets/<tenantId>/<projectId>/
      await safeDelete(() => azureBlob.deletePrefix(`datasets/${tenantId}/${projectId}/`));

      try {
        logger.info('[DELETE][CLEANUP] governed project cleanup done', { tenantId: String(tenantId), projectId, threadId });
      } catch { }
    })();

    // Finally, remove conversation from DB
    await Conversation.deleteOne({ threadId, userId, tenantId });

    return res.json({ ok: true, threadId });
  } catch (e) {
    logger.error('[DELETE][CONVERSATION] hiba:', e?.message);
    return res.status(500).json({ error: 'Törlés közben hiba történt.' });
  }
};
