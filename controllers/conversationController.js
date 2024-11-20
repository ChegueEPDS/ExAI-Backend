const Conversation = require('../models/conversation');
const axios = require('axios');
const logger = require('../config/logger');
const categorizeMessageUsingAI = require('../helpers/categorizeMessage');
const delay = require('../helpers/delay');
const { body, validationResult } = require('express-validator');
const { marked } = require('marked');
const tiktoken = require('tiktoken');
const assistants = require('../config/assistants');
const User = require('../models/user'); // Ha a felhasználó modell így van nevezve

// Új beszélgetés indítása
exports.startNewConversation = async (req, res) => {
  try {
    const userId = req.userId;

    const threadResponse = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });
    const threadId = threadResponse.data.id;

    const newConversation = new Conversation({
      threadId,
      messages: [],
      userId, // A beszélgetéshez hozzárendeljük a felhasználót
    });

    await newConversation.save();
    logger.info('Új szál létrehozva:', threadId);

    res.status(200).json({ threadId });
  } catch (error) {
    logger.error('Hiba az új szál létrehozása során:', error.message);
    res.status(500).json({ error: 'Nem sikerült új szálat létrehozni.' });
  }
};

const encoder = tiktoken.get_encoding('o200k_base');  // Vagy egyéb modellekhez más encodingot használj, pl. 'gpt-4'

// Üzenet küldése egy meglévő szálban

exports.sendMessage = [
  body('message').isString().notEmpty().trim().escape(),
  body('threadId').isString().notEmpty().trim().escape(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.error('Validációs hiba:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { message, threadId } = req.body;
      const userId = req.userId;
      if (!userId) {
        logger.error('Hiányzó userId a kérésből.');
        return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
    }

      logger.info(`Üzenet fogadva a szálhoz: ${threadId}, Üzenet: ${message}`);

      // Felhasználó lekérése és céges asszisztens ID kiválasztása
      const user = await User.findById(userId).select('company');
      if (!user) {
        return res.status(404).json({ error: 'Felhasználó nem található.' });
      }

      const companyId = user.company;
      const assistantId = assistants[companyId] || assistants['default'];

      logger.info(`Assistant ID kiválasztva: ${assistantId} (Company: ${companyId})`);

      const conversation = await Conversation.findOne({ threadId });

      if (!conversation) {
        logger.error('Beszélgetés nem található a megadott szálhoz:', threadId);
        return res.status(404).json({ error: 'A megadott szál nem található.' });
      }

      // Kimenő üzenet tokenjeinek számolása
      const userMessageTokens = encoder.encode(message).length;
      logger.info(`Felhasználó üzenet tokenek száma: ${userMessageTokens}`);

      // Üzenet küldése a meglévő API-hoz
      await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, { role: 'user', content: message }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      });

      const runResponse = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, { assistant_id: assistantId }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      });

      let completed = false;
      let retries = 0;
      const maxRetries = 30;

      while (!completed && retries < maxRetries) {
        await delay(1000);
        retries++;

        const statusResponse = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${runResponse.data.id}`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2',
          },
        });

        if (statusResponse.data.status === 'completed') {
          completed = true;
        } else if (statusResponse.data.status === 'failed') {
          throw new Error('A futás sikertelen.');
        }
      }

      if (!completed) {
        throw new Error('A futás nem fejeződött be a megadott idő alatt.');
      }

      const messagesResponse = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      });

      const assistantMessage = messagesResponse.data.data.find(m => m.role === 'assistant');
      if (!assistantMessage) {
        throw new Error('Nem található asszisztens üzenet');
      }

      let assistantContent = '';
      if (Array.isArray(assistantMessage.content)) {
        assistantMessage.content.forEach(item => {
          if (item.type === 'text' && item.text && item.text.value) {
            assistantContent += item.text.value;
          }
        });
      } else {
        assistantContent = assistantMessage.content;
      }

      assistantContent = assistantContent.replace(/【.*?】/g, '');
      const assistantContentHtml = marked(assistantContent);

      // Asszisztens válasz tokenjeinek számolása
      const assistantMessageTokens = encoder.encode(assistantContent).length;
      logger.info(`Asszisztens üzenet tokenek száma: ${assistantMessageTokens}`);

      const finalCategory = await categorizeMessageUsingAI(message, assistantContentHtml);

      conversation.messages.push({
        role: 'user', 
        content: message, 
        category: finalCategory,
        inputToken: userMessageTokens
      });

      conversation.messages.push({
        role: 'assistant', 
        content: assistantContentHtml,
        outputToken: assistantMessageTokens
      });

      await conversation.save();

      res.json({ html: assistantContentHtml });
    } catch (error) {
      logger.error('Hiba az üzenetküldés során:', error.message);
      res.status(500).json({ error: 'Váratlan hiba történt.' });
    }
  }
];


// Üzenet értékelése
exports.rateMessage = async (req, res) => {
  const { threadId, messageIndex, rating } = req.body;

    try {
      const conversation = await Conversation.findOne({ threadId });

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
    const conversation = await Conversation.findOne({ threadId });
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

// Beszélgetés törlése
exports.deleteConversation = async (req, res) => {
  const { threadId } = req.params;
  try {
    const conversation = await Conversation.findOneAndDelete({ threadId });

    if (!conversation) {
      return res.status(404).json({ error: 'A megadott szál nem található.' });
    }

    res.status(200).json({ message: 'A beszélgetés törlésre került.' });
  } catch (error) {
    logger.error('Hiba a beszélgetés törlése során:', error.message);
    res.status(500).json({ error: 'Váratlan hiba történt.' });
  }
};

// Korábbi beszélgetések listázása
exports.getConversations = async (req, res) => {
  try {
    const userId = req.userId;  // Bejelentkezett felhasználó azonosítója
    const conversations = await Conversation.find({ userId });  // Csak a bejelentkezett user beszélgetései
    const conversationList = conversations.map(conversation => ({
      threadId: conversation.threadId,
      messages: conversation.messages,
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
    const conversation = await Conversation.findOne({ threadId, userId: req.userId });

    if (!conversation) {
      return res.status(404).json({ error: 'A megadott szál nem található vagy nem hozzáférhető.' });
    }

    res.status(200).json(conversation.messages);  // A beszélgetés üzeneteinek visszaküldése
  } catch (error) {
    logger.error('Hiba a beszélgetés betöltése során:', error.message);
    res.status(500).json({ error: 'Váratlan hiba történt.' });
  }
};
