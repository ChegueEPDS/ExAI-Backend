const Conversation = require('../models/conversation');
const axios = require('axios');

// Create a single axios instance with shared headers for Assistants v2
const axiosInst = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'assistants=v2',
  },
  timeout: 60_000,
});

// Resolve assistant id from tenant key
function resolveAssistantIdByTenant(tenantKey) {
  try {
    const map = require('../config/assistants');
    return (map.byTenant && map.byTenant[tenantKey]) ? map.byTenant[tenantKey] : (map.default || map['default']);
  } catch {
    return process.env.ASSISTANT_ID_DEFAULT || '';
  }
}
// Optional: try to load User model to resolve plan (won't throw if not present)
let UserModelOptional = null;
try {
  // Adjust the path if your user model lives elsewhere
  UserModelOptional = require('../models/user');
} catch (_) {
  // silently ignore if model not available
}

// Resolve a user's plan; tries DB if model exists, otherwise returns null
async function getUserPlan(userId) {
  try {
    if (!userId || !UserModelOptional) return null;
    const u = await UserModelOptional.findById(userId).select('plan subscription tenantPlan');
    const plan =
      (u?.subscription?.tier || u?.subscription?.plan || u?.tenantPlan || u?.plan || '').toString().toLowerCase();
    return plan || null;
  } catch {
    return null;
  }
}

// Poll a run until completion (with basic backoff and status checks)
async function waitForRun(threadId, runId, { maxMs = 60_000 } = {}) {
  const start = Date.now();
  let delayMs = 500;
  while (Date.now() - start < maxMs) {
    const { data } = await axiosInst.get(`/threads/${threadId}/runs/${runId}`);
    const s = data.status;
    if (s === 'completed') return data;
    if (s === 'requires_action') {
      throw new Error('Run requires_action (tool calls not handled here).');
    }
    if (s === 'failed' || s === 'cancelled' || s === 'expired') {
      const errMsg = data?.last_error?.message ? ` - ${data.last_error.message}` : '';
      throw new Error(`Run ended with status: ${s}${errMsg}`);
    }
    await delay(delayMs);
    delayMs = Math.min(delayMs * 1.5, 3000);
  }
  throw new Error('Run polling timeout.');
}

const { marked } = require('marked');
marked.setOptions({ mangle: false, headerIds: false });
const logger = require('../config/logger');
const { delay } = require('../helpers/delay');
const { categorizeMessageUsingAI } = require('../helpers/categorizeMessage');

// Új beszélgetés indítása
const startNewConversation = async (userId) => {
  try {
    const threadResponse = await axiosInst.post('/threads', {});
    
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

    await axiosInst.post(`/threads/${threadId}/messages`, {
      role: 'user',
      content: message,
      metadata: { userId }
    });

    // Decide model override: if customer is on TEAM, force gpt-5-mini; otherwise keep assistant default
    const userPlan = await getUserPlan(userId);
    const runBody = {
      assistant_id: process.env.ASSISTANT_ID
    };
    if (userPlan === 'team') {
      runBody.model = 'gpt-4o-mini';
    }

    const runResponse = await axiosInst.post(`/threads/${threadId}/runs`, runBody);

    // Wait for completion and capture the final run payload (contains selected model)
    const finalRun = await waitForRun(threadId, runResponse.data.id);

    // Log thread, resolved user plan and the actual model used
    logger.info(`[Assistant Completed] thread=${threadId} plan=${userPlan || 'unknown'} model=${finalRun?.model || 'unknown'}`);

    const messagesResponse = await axiosInst.get(`/threads/${threadId}/messages`, {
      params: { order: 'desc', limit: 5 }
    });

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

    assistantContent = (assistantContent || '').replace(/【[^【】\n\r]{0,200}】/g, '');
    const assistantContentHtml = marked(assistantContent);

    const finalCategory = await categorizeMessageUsingAI(message, assistantContentHtml);

    conversation.messages.push({ role: 'user', content: message, category: finalCategory });
    // Persist which model produced the assistant reply for later inspection
    conversation.messages.push({ role: 'assistant', content: assistantContentHtml, model: finalRun?.model });
    await conversation.save();

    // Also return the model to the caller (optional for UI/debug)
    return { html: assistantContentHtml, model: finalRun?.model, plan: userPlan || null };
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
