const Conversation = require('../models/conversation');
const InjectionRule = require('../models/injectionRule');
const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../config/logger');
const categorizeMessageUsingAI = require('../helpers/categorizeMessage');
const delay = require('../helpers/delay');
const { body, validationResult } = require('express-validator');
const { marked } = require('marked');
const tiktoken = require('tiktoken');
const assistants = require('../config/assistants');
const User = require('../models/user'); 
const { fetchFromAzureSearch } = require('../helpers/azureSearchHelpers');
console.log('fetchFromAzureSearch:', typeof fetchFromAzureSearch);
const { createEmbedding } = require('../helpers/openaiHelpers');
const sanitizeHtml = require('sanitize-html');
const multer = require('multer');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const fs = require('fs');
const { runUploadAndSummarize } = require('../services/summaryCore');
const { notifyAndStore } = require('../lib/notifications/notifier');

const FormData = require('form-data');

// ===== Background Job helpers (persist progress to Mongo) =====
async function jobInit(conversation, type, initial) {
  conversation.job = {
    type,
    status: 'running',
    stage: initial?.stage || 'start',
    progress: {
      filesTotal: initial?.filesTotal || 0,
      filesProcessed: 0,
      chunksTotal: 0,
      chunksCompleted: 0,
      tokensUsed: 0,
      tokenBudget: 0,
      lastMessage: '',
      ...(initial?.progress || {})
    },
    meta: {
      assistantId: initial?.assistantId || '',
      threadId: conversation.threadId,
      files: initial?.files || [],
      totalChars: initial?.totalChars || 0,
      ...(initial?.meta || {})
    },
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    updatedAt: new Date()
  };
  conversation.hasBackgroundJob = true;
  await conversation.save();
}

async function jobPatch(conversation, patch) {
  if (!conversation.job) conversation.job = {};
  const job = conversation.job;
  if (patch.status) job.status = patch.status;
  if (patch.stage) job.stage = patch.stage;
  if (patch.progress) {
    job.progress = { ...(job.progress || {}), ...patch.progress };
  }
  if (patch.meta) {
    job.meta = { ...(job.meta || {}), ...patch.meta };
  }
  if (patch.error) {
    job.error = { ...(job.error || {}), ...patch.error };
  }
  if (patch.startedAt !== undefined) job.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) job.finishedAt = patch.finishedAt;
  job.updatedAt = new Date();
  conversation.hasBackgroundJob = ['queued','running'].includes(job.status);
  await conversation.save();
}

async function jobSucceed(conversation) {
  await jobPatch(conversation, { status: 'succeeded', stage: 'done', finishedAt: new Date() });
}

async function jobFail(conversation, err) {
  await jobPatch(conversation, {
    status: 'failed',
    stage: 'error',
    error: {
      message: err?.message || 'Unknown error',
      code: err?.code || '',
      raw: err?.response?.data || null
    },
    finishedAt: new Date()
  });
}

// === Tokenization helpers at module scope ===
const encoder = tiktoken.get_encoding('o200k_base');  // shared tokenizer

function estimateTokens(str, outputFactor = 1.6) {
  const inTok = encoder.encode(str || '').length;
  return Math.ceil(inTok * outputFactor);
}

function chunkByTokens(str, maxTokens) {
  const ids = encoder.encode(str || '');
  const chunks = [];
  for (let i = 0; i < ids.length; i += maxTokens) {
    const slice = ids.slice(i, i + maxTokens);
    chunks.push(encoder.decode(slice));
  }
  return chunks.length ? chunks : [''];
}

const upload = multer({ storage: multer.memoryStorage() });
exports.uploadMulter = upload;

const axiosClient = axios.create({
  timeout: 300000, // 5 minutes
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});


// ===== SSE helper for streaming progress to the client =====
function sseInit(req, res) {
  // If app-level SSE middleware already sent headers / flushed, do not set again
  const headersAlreadySent = res.headersSent || req?.isSSE;

  if (!headersAlreadySent) {
    // Ensure status and SSE headers only if not yet sent
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }

  // Disable server-side socket timeout for long-running streams
  if (res.socket && typeof res.socket.setTimeout === 'function') {
    res.socket.setTimeout(0);
  }

  // Heartbeat to keep proxies/connections alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (e) {
      // connection likely closed
    }
  }, 15000);

  const send = (event, payload) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      // connection likely closed
    }
  };

  // Stop heartbeat when client disconnects
  res.on('close', () => {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  });

  return send;
}

// ===== Mixed-files upload (no vector store) -> full-text extraction -> summarize (SSE) =====
exports.uploadAndSummarizeStream = async (req, res) => {
  // Initialize SSE channel
  const send = sseInit(req, res);

  let conversation; // visible in catch
  try {
    const userId = req.userId;
    const { threadId, userMessage } = req.body || {};
    const files = req.files || [];

    if (!userId) {
      send('error', { message: 'Hiányzó vagy érvénytelen JWT.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!threadId) {
      send('error', { message: 'threadId kötelező.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!files.length) {
      send('error', { message: 'Nincs feltöltött fájl.' });
      send('done', { ok: false });
      return res.end();
    }

    // Validate conversation belongs to the current user
    conversation = await Conversation.findOne({ threadId, userId });
    if (!conversation) {
      send('error', { message: 'A beszélgetés nem található vagy nem hozzáférhető.' });
      send('done', { ok: false });
      return res.end();
    }

    // Only one background job at a time per conversation
    if (conversation.job && conversation.job.status === 'running') {
      send('error', { message: 'Már fut egy háttérfeladat ezen a beszélgetésen.' });
      send('done', { ok: false });
      return res.end();
    }

    // Pick assistant based on user's company
    const user = await User.findById(userId).select('company');
    if (!user) {
      send('error', { message: 'Felhasználó nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    const companyId = user.company;
    const assistantId = assistants[companyId] || assistants['default'];

    // Initialize job in DB
    await jobInit(conversation, 'upload_and_summarize', {
      stage: 'start',
      filesTotal: files.length,
      files: files.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })),
      assistantId,
      totalChars: 0
    });

    // Kick off
    send('info', { stage: 'start', message: 'Feldolgozás indul.' });

    const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

    // Delegate to service: it will emit SSE updates through `emit`, and persist via `patch`
    const { finalHtml, messageId } = await runUploadAndSummarize(
      {
        files,
        threadId,
        assistantId,
        baseUrl,
        openaiApiKey: process.env.OPENAI_API_KEY
      },
      {
        emit: (event, payload) => {
          try { send(event, payload); } catch {}
        },
        patch: async (patchObj) => {
          try { await jobPatch(conversation, patchObj); } catch {}
        }
      }
    );

    // Persist final assistant answer into the conversation
    const listHtml = files.map(x => `<li>${x.originalname}</li>`).join('');
    const fallbackMsg = `Summary for ${files.length} files:\n<ul>${listHtml}</ul>`;
    const metaUserMsg = (typeof userMessage === 'string' && userMessage.trim())
      ? userMessage.trim()
      : fallbackMsg;
    conversation.messages.push({ role: 'user', content: metaUserMsg });
    conversation.messages.push({ role: 'assistant', content: finalHtml });
    await conversation.save();

    const lastAssistantMessage = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

    // Notify user that the summary is ready
    try {
      const fileNames = (conversation.job?.meta?.files || []).map(f => f.name);
      await notifyAndStore(userId, {
        type: 'project-summary-complete',
        title: 'Project summary is ready',
        message: `Processed ${fileNames.length} file(s).`,
        data: {
          threadId: conversation.threadId,
          files: fileNames
        },
        meta: {
          route: '/assistant',
          query: { threadId: conversation.threadId }
        }
      });
    } catch (e) {
      logger.warn('Failed to send completion notification:', e?.message);
    }

    // Mark job success and finish SSE
    await jobSucceed(conversation);
    send('final', { html: finalHtml, messageId: lastAssistantMessage?._id || messageId || null });
    send('done', { ok: true });
    return res.end();

  } catch (error) {
    if (conversation) {
      try { await jobFail(conversation, error); } catch {}
    }
    // Notify user about failure
    try {
      const targetUserId = (conversation?.userId || req.userId);
      const targetThreadId = (conversation?.threadId || req.body?.threadId || null);
      await notifyAndStore(targetUserId, {
        type: 'project-summary-failed',
        title: 'Project summary failed',
        message: error?.message || 'Unexpected error.',
        data: { threadId: targetThreadId },
        meta: {
          route: '/assistant',
          query: { threadId: targetThreadId }
        }
      });
    } catch (e) {
      logger.warn('Failed to send failure notification:', e?.message);
    }
    logger.error('Hiba a feltöltés-összefoglalás során (service):', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status,
    });
    try {
      send('error', { message: error.message || 'Váratlan hiba történt.' });
      send('done', { ok: false });
    } finally {
      return res.end();
    }
  }
};


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


// Üzenet küldése egy meglévő szálban
const imageMapping = {
  "építési hely": ["KESZ_7_MELL-1.png", "KESZ_7_MELL-7.png"],
  "zártsorú beépítési mód": ["KESZ_7_MELL-2.png", "KESZ_7_MELL-3.png", "KESZ_7_MELL-4.png", "KESZ_7_MELL-5.png"],
  "épületköz": ["KESZ_7_MELL-8.png"],
  "közterület felé eső építési vonal": ["KESZ_7_MELL-9.png", "KESZ_7_MELL-10.png"],
  "épületrész hátraléptetése": ["KESZ_7_MELL-11.png"],
  "zöldfelület": ["KESZ_7_MELL-12.png"],
  "szintterületi mutató": ["KESZ_7_MELL-13.png"],
  "parkolás": ["KESZ_7_MELL-13.png"],
  "parkoló": ["KESZ_7_MELL-13.png"],
  "garázs": ["KESZ_7_MELL-13.png"],
  "építési hely meghatározás":["KESZ_7_MELL-7.png"],
  "utcai párkánymagasság":["KESZ_7_MELL-15.png"],
  "magassági idom":["KESZ_7_MELL-18.png"],
  "Az építési övezetek magassági szabályozása":["KESZ_4_MELL_MAGASSAG.png"],
  "XIII kerület magassági szabályozás":["KESZ_4_MELL_MAGASSAG.png"],
  "épületmagasság":["KESZ_4_MELL_MAGASSAG.png"],
};

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
      const { message, threadId, category } = req.body;
      const userId = req.userId;

      if (!userId) {
        logger.error('Hiányzó userId a kérésből.');
        return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
      }

      logger.info(`Üzenet fogadva a szálhoz: ${threadId}, Üzenet: ${message}`);

      const user = await User.findById(userId).select('company');
      if (!user) {
        return res.status(404).json({ error: 'Felhasználó nem található.' });
      }

      const companyId = user.company;
      const assistantId = assistants[companyId] || assistants['default'];

      let applicableInjection = null;
      if (companyId === 'wolff' || assistantId === process.env.ASSISTANT_ID_WOLFF) {
        const allRules = await InjectionRule.find();
        // Kiválasztjuk azt a szabályt, ami a legtöbb kulcsszót találja meg
        const scoredMatches = allRules
          .map(rule => {
            try {
              const regex = new RegExp(rule.pattern, 'gi');
              const matches = message.match(regex);
              const score = matches ? matches.length : 0;
              return score > 0 ? { rule, score } : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        const matchingRule = scoredMatches.length > 0 ? scoredMatches[0].rule : null;
        if (matchingRule) {
          logger.info('💡 Injection rule alkalmazva:', matchingRule);
          applicableInjection = matchingRule.injectedKnowledge;
        }
      }

      let finalCategory = category;
      if (!finalCategory) {
        try {
          finalCategory = await categorizeMessageUsingAI(message);
          logger.info('Automatikusan kategorizált:', finalCategory);
        } catch (err) {
          logger.warn('Nem sikerült automatikusan kategorizálni:', err.message);
          finalCategory = null;
        }
      }

      const conversation = await Conversation.findOne({ threadId });
      if (!conversation) {
        logger.error('Beszélgetés nem található a megadott szálhoz:', threadId);
        return res.status(404).json({ error: 'A megadott szál nem található.' });
      }

      // Ellenőrzés: van-e aktív run a szálhoz
      const runsResponse = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs`, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      });

      const activeRun = runsResponse.data.data.find(
        r => ['queued', 'in_progress', 'requires_action', 'cancelling'].includes(r.status)
      );

      if (activeRun) {
        logger.warn('⚠️ Aktív run már létezik ehhez a threadhez:', {
          threadId,
          activeRunId: activeRun.id,
          status: activeRun.status
        });
        return res.status(429).json({
          error: `Már fut egy aktív feldolgozás (${activeRun.status}). Kérlek, várj amíg véget ér.`,
          activeRunId: activeRun.id,
          status: activeRun.status
        });
      }

      await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        role: 'user',
        content: message,
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      });

      let runPayload = { assistant_id: assistantId };

      if (applicableInjection) {
        const assistantData = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });

        const assistantPrompt = assistantData.data.instructions || '';

        const finalInstructions = `${assistantPrompt}\n\nAlways put the following sentence at the end of the explanation part as a <strong>Note:</strong>, exactly as written, in a separate paragraph between <em> tags: :\n\n"${applicableInjection}"`;

        logger.info('📋 Final instructions before sending:', finalInstructions);
        console.log('📋 Final instructions before sending:', finalInstructions);

        runPayload.instructions = finalInstructions;
      }

      const runResponse = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, runPayload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      });

      let completed = false;
      let retries = 0;
      const maxRetries = 60;

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

        const status = statusResponse.data.status;

        if (status === 'completed') {
          completed = true;
        } else if (['failed', 'cancelled', 'expired'].includes(status)) {
          throw new Error(`A futás sikertelen vagy megszakadt. Állapot: ${status}`);
        }

        // opcionális: logolás minden lépésben
        logger.debug(`⏳ Run státusz (${retries}/${maxRetries}): ${status}`);
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

      assistantContent = sanitizeHtml(assistantContent, {
        allowedTags: ['b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        allowedAttributes: { 'span': ['class'] },
        disallowedTagsMode: 'discard'
      });

      let assistantContentHtml = marked(assistantContent);

      if (finalCategory) {
        assistantContentHtml = assistantContentHtml.replace(
          /<h3>According to the document:<\/h3>/,
          `<h3>According to ${finalCategory}:</h3>`
        );
      }

      let matchedImages = [];
      Object.keys(imageMapping).forEach(keyword => {
        if (message.toLowerCase().includes(keyword) || assistantContent.toLowerCase().includes(keyword)) {
          matchedImages = [...matchedImages, ...imageMapping[keyword]];
        }
      });

      matchedImages = [...new Set(matchedImages)];
      const imageUrls = matchedImages.map(filename => `${process.env.BASE_URL}/uploads/${filename}`);

      const assistantEntry = {
        role: 'assistant',
        content: assistantContentHtml,
        images: imageUrls
      };

      conversation.messages.push({ role: 'user', content: message, ...(finalCategory && { category: finalCategory }) });
      conversation.messages.push(assistantEntry);

      await conversation.save();

      const lastAssistantMessage = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

      
      res.json({
        html: assistantContentHtml,
        images: imageUrls.length > 0 ? imageUrls : [],
        messageId: lastAssistantMessage?._id  // ✅ új elem _id-ját visszaküldjük
      });

    } catch (error) {
      logger.error('Hiba az üzenetküldés során:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data,
        status: error.response?.status,
      });
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
    const conversationList = conversations.map(c => ({
  threadId: c.threadId,
  messages: c.messages,
  job: c.job || null,
  hasBackgroundJob: !!c.hasBackgroundJob,
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