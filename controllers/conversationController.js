const crypto = require('crypto');
const { body } = require('express-validator');
const { memoryUpload } = require('../middlewares/uploadFactory');
const logger = require('../config/logger');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const { attachAssistantRatingCategory, deleteConversationStats } = require('../services/conversationStatsService');

const { handleSendMessageStream } = require('../services/chatStreamService');

exports.sendMessageStream = (req, res) => handleSendMessageStream(req, res);

const { handleUploadAndAskStream } = require('../services/uploadAndAskService');
const { handleUploadChatFile } = require('../services/chatFileService');

const upload = memoryUpload({ fileSizeMb: 25, files: 10, fields: 50 });
exports.uploadMulter = upload;

exports.uploadAndAskStream = [
  upload.array('files', 10),
  (req, res) => handleUploadAndAskStream(req, res)
];

exports.uploadChatFile = [
  upload.single('file'),
  (req, res) => handleUploadChatFile(req, res)
];

const { handleSendMessage } = require('../services/chatMessageService');

// Új beszélgetés indítása
exports.startNewConversation = async (req, res) => {
  try {
    const userId = req.userId;
    // We no longer create OpenAI Threads/Runs. The conversation id is generated and
    // the model state is chained via Responses API previous_response_id (store:true).
    const threadId = `c_${crypto.randomBytes(12).toString('hex')}`;

    const newConversation = new Conversation({
      threadId,
      messages: [],
      userId,
      tenantId: req.scope?.tenantId || undefined,
      lastResponseId: null,
    });

    await newConversation.save();
    logger.info('Új szál létrehozva:', threadId);

    res.status(200).json({ threadId });
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
      attachAssistantRatingCategory(conversation.messages, messageIndex);
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
      .select('threadId messages job hasBackgroundJob updatedAt createdAt')
      .lean();

    const conversationList = conversations.map(c => ({
      threadId: c.threadId,
      messages: c.messages,
      job: c.job || null,
      hasBackgroundJob: !!c.hasBackgroundJob,
      updatedAt: c.updatedAt,
    }));

    res.status(200).json(conversationList);  // Az összes beszélgetés visszaküldése
  } catch (error) {
    logger.error('Hiba a beszélgetések lekérése során:', error.message);
    res.status(500).json({ error: 'Váratlan hiba történt.' });
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

    // Finally, remove conversation from DB
    await safeDelete(() => deleteConversationStats(conversation));
    await Conversation.deleteOne({ threadId, userId, tenantId });

    return res.json({ ok: true, threadId });
  } catch (e) {
    logger.error('[DELETE][CONVERSATION] hiba:', e?.message);
    return res.status(500).json({ error: 'Törlés közben hiba történt.' });
  }
};
