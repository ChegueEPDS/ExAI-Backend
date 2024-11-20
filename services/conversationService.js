const Conversation = require('../models/conversation');
const axios = require('axios');
const { marked } = require('marked');
const logger = require('../config/logger');
const { delay } = require('../helpers/delay');
const { categorizeMessageUsingAI } = require('../helpers/categorizeMessage');

// Új beszélgetés indítása
const startNewConversation = async (userId) => {
  try {
    const threadResponse = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    
    const threadId = threadResponse.data.id;

    const newConversation = new Conversation({
      threadId,
      messages: [],
      userId,
    });

    await newConversation.save();
    logger.info(`Új szál létrehozva: ${threadId}`);

    return { threadId };
  } catch (error) {
    logger.error('Hiba az új szál létrehozása során:', error.message);
    throw new Error('Nem sikerült új szálat létrehozni.');
  }
};

// Üzenet küldése egy meglévő szálban
const sendMessageInConversation = async (message, threadId, userId) => {
  try {
    const conversation = await Conversation.findOne({ threadId, userId });

    if (!conversation) {
      throw new Error('A megadott szál nem található.');
    }

    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      { role: 'user', content: message },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    const runResponse = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      { assistant_id: process.env.ASSISTANT_ID },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    let completed = false;
    let retries = 0;
    const maxRetries = 30;

    while (!completed && retries < maxRetries) {
      await delay(1000);
      retries++;

      const statusResponse = await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runResponse.data.id}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2',
          },
        }
      );

      if (statusResponse.data.status === 'completed') {
        completed = true;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error('A futás sikertelen.');
      }
    }

    if (!completed) {
      throw new Error('A futás nem fejeződött be a megadott idő alatt.');
    }

    const messagesResponse = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    const assistantMessage = messagesResponse.data.data.find(
      (m) => m.role === 'assistant'
    );
    if (!assistantMessage) {
      throw new Error('Nem található asszisztens üzenet');
    }

    let assistantContent = '';
    if (Array.isArray(assistantMessage.content)) {
      assistantMessage.content.forEach((item) => {
        if (item.type === 'text' && item.text && item.text.value) {
          assistantContent += item.text.value;
        }
      });
    } else {
      assistantContent = assistantMessage.content;
    }

    assistantContent = assistantContent.replace(/【.*?】/g, '');
    const assistantContentHtml = marked(assistantContent);

    const finalCategory = await categorizeMessageUsingAI(message, assistantContentHtml);

    conversation.messages.push({ role: 'user', content: message, category: finalCategory });
    conversation.messages.push({ role: 'assistant', content: assistantContentHtml });
    await conversation.save();

    return { html: assistantContentHtml };
  } catch (error) {
    logger.error('Hiba az üzenetküldés során:', error.message);
    throw new Error('Váratlan hiba történt.');
  }
};

// Korábbi beszélgetések lekérése
const getConversationsByUser = async (userId) => {
  try {
    const conversations = await Conversation.find({ userId });
    return conversations.map(conversation => ({
      threadId: conversation.threadId,
      messages: conversation.messages,
    }));
  } catch (error) {
    logger.error('Hiba a beszélgetések lekérése során:', error.message);
    throw new Error('Váratlan hiba történt.');
  }
};

// Korábbi beszélgetés betöltése
const getConversationByThreadId = async (threadId, userId) => {
  try {
    const conversation = await Conversation.findOne({ threadId, userId });

    if (!conversation) {
      throw new Error('A megadott szál nem található vagy nem hozzáférhető.');
    }

    return conversation.messages;
  } catch (error) {
    logger.error('Hiba a beszélgetés betöltése során:', error.message);
    throw new Error('Váratlan hiba történt.');
  }
};

module.exports = {
  startNewConversation,
  sendMessageInConversation,
  getConversationsByUser,
  getConversationByThreadId,
};
