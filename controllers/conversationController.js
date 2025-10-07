// SSE streaming chat endpoint (real Assistants API token stream)
exports.sendMessageStream = async (req, res) => {
  const send = sseInit(req, res);

  try {
    const { message, threadId, category } = req.body || {};
    const userId = req.userId;

    // ---- Validations ----
    if (!userId) {
      send('error', { message: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      send('error', { message: 'A message kötelező, nem lehet üres.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!threadId || typeof threadId !== 'string' || !threadId.trim()) {
      send('error', { message: 'A threadId kötelező, nem lehet üres.' });
      send('done', { ok: false });
      return res.end();
    }

    logger.info(`[STREAM] Üzenet fogadva a szálhoz: ${threadId}`);

    // ---- Resolve user & assistant ----
    const user = await User.findById(userId).select('tenantId');
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    if (!tenantId) {
      send('error', { message: 'Hiányzó tenant azonosító.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!user) {
      send('error', { message: 'Felhasználó nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    const tenantDoc = await Tenant.findById(tenantId).select('name');
    if (!tenantDoc) {
      send('error', { message: 'Tenant nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    const tenantKey = String(tenantDoc.name || '').toLowerCase();
    const assistantId = assistants.byTenant?.[tenantKey] || assistants['default'];
    // DEBUG: Assistant selection trace (STREAM)
    logger.debug('[ASSISTANT PICK][STREAM] req.scope.tenantId:', req.scope?.tenantId);
    logger.debug('[ASSISTANT PICK][STREAM] user.tenantId:', user?.tenantId ? String(user.tenantId) : null);
    logger.debug('[ASSISTANT PICK][STREAM] resolved tenantId:', tenantId);
    logger.debug('[ASSISTANT PICK][STREAM] tenantDoc:', { id: tenantDoc?._id, name: tenantDoc?.name });
    logger.debug('[ASSISTANT PICK][STREAM] tenantKey:', tenantKey);
    logger.debug('[ASSISTANT PICK][STREAM] assistants.byTenant keys:', Object.keys(assistants.byTenant || {}));
    logger.debug('[ASSISTANT PICK][STREAM] assistants.byTenant[tenantKey]:', (assistants.byTenant || {})[tenantKey] || null);
    logger.debug('[ASSISTANT PICK][STREAM] default assistantId:', assistants['default']);
    logger.debug('[ASSISTANT PICK][STREAM] chosen assistantId:', assistantId);

    // ---- Determine user plan (best-effort from various middleware-attached places) ----
    // 1) Try req.auth.subscription?.plan (auth controller attaches subscription snapshot)
    // 2) Fallbacks to req.user.subscription?.tier, req.user.plan, req.auth.subscription?.tier, req.auth.plan, req.scope.plan
    // 3) Final fallback: query DB (Subscription / Tenant) by tenantId
    let userPlan =
      (req.auth && req.auth.subscription?.plan) ||
      (req.user && (req.user.subscription?.tier || req.user.plan)) ||
      (req.auth && (req.auth.subscription?.tier || req.auth.plan)) ||
      (req.scope && req.scope.plan) ||
      null;

    if (!userPlan) {
      try {
        const subDoc = await Subscription.findOne({ tenantId }).select('tier');
        const tenDoc = await Tenant.findById(tenantId).select('plan');
        userPlan = (subDoc?.tier || tenDoc?.plan || 'unknown');
        if (userPlan !== 'unknown') {
          logger.info(`[STREAM] Plan resolved via DB fallback: plan=${userPlan}`);
        }
      } catch (e) {
        userPlan = 'unknown';
        logger.warn('[STREAM] Failed to resolve plan from DB fallback:', e?.message);
      }
    }
    logger.info(
      `[STREAM] Context: thread=${threadId} tenant=${tenantKey} plan=${userPlan} assistantId=${assistantId}`
    );

    // ---- Optional injection rules (Wolff) ----
    let applicableInjection = null;
    if (tenantKey === 'wolff' || assistantId === process.env.ASSISTANT_ID_WOLFF) {
      const allRules = await InjectionRule.find();
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
        logger.info('[STREAM] 💡 Injection rule alkalmazva:', matchingRule);
        applicableInjection = matchingRule.injectedKnowledge;
      }
    }

    // ---- Category detection (optional) ----
    let finalCategory = category;
    if (!finalCategory) {
      try {
        finalCategory = await categorizeMessageUsingAI(message);
        logger.info('[STREAM] Automatikusan kategorizált:', finalCategory);
      } catch (err) {
        logger.warn('[STREAM] Nem sikerült automatikusan kategorizálni:', err.message);
        finalCategory = null;
      }
    }

    // ---- Conversation ownership check ----
    const conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) {
      send('error', { message: 'A megadott szál nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    if (String(conversation.userId) !== String(userId)) {
      send('error', { message: 'A beszélgetés nem tartozik a felhasználóhoz.' });
      send('done', { ok: false });
      return res.end();
    }

    // ---- Check there is no active run ----
    const runsResponse = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' },
    });
    const activeRun = runsResponse.data.data.find(r => ['queued', 'in_progress', 'requires_action', 'cancelling'].includes(r.status));
    if (activeRun) {
      send('error', { message: `Már fut egy aktív feldolgozás (${activeRun.status}). Kérlek, várj amíg véget ér.`, activeRunId: activeRun.id, status: activeRun.status });
      send('done', { ok: false });
      return res.end();
    }

    // ---- Post user message to thread ----
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      { role: 'user', content: message },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' } }
    );

    // ---- Prepare run payload, add instructions if we have an injection ----
    const payload = { assistant_id: assistantId, stream: true };

    // If we have injection, fetch assistant instructions and append
    if (applicableInjection) {
      const assistantData = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' }
      });
      const assistantPrompt = assistantData.data.instructions || '';
      const finalInstructions = `${assistantPrompt}\n\nAlways put the following sentence at the end of the explanation part as a <strong>Note:</strong>, exactly as written, in a separate paragraph between <em> tags: :\n\n"${applicableInjection}"`;
      logger.info('[STREAM] 📋 Final instructions before sending:', finalInstructions);
      payload.instructions = finalInstructions;
    }

    // ---- OpenAI SSE stream (no model override; use assistant default) ----
    const openaiResp = await axios({
      method: 'post',
      url: `https://api.openai.com/v1/threads/${threadId}/runs`,
      data: payload,
      responseType: 'stream',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
        Connection: 'keep-alive'
      },
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: 0
    });
    logger.info(`[STREAM] Using assistant default model (no override).`);
    send('assistant.status', { stage: 'openai.stream.start' });

    let accText = '';
    let lastAssistantMessageId = null;
    const stream = openaiResp.data;
    let buffer = '';
    let hadTokens = false;
    let lastSeenModel = null;

    const flushBlocks = (raw) => {
      const blocks = raw.split('\n\n');
      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let eventName = null;
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!eventName) continue;
        if (eventName === 'ping' || dataStr === '[DONE]') continue;

        let payload = null;
        try { payload = dataStr ? JSON.parse(dataStr) : null; } catch {}

        // --- helper to normalize delta shapes from OpenAI (Assistants v2 and fallbacks) ---
        const extractDeltaPieces = (payloadObj) => {
          const pieces = [];

          // 1) Canonical Assistants v2: payload.delta.content[] variants
          const contentArr = payloadObj?.delta?.content;
          if (Array.isArray(contentArr)) {
            for (const part of contentArr) {
              // a) output_text.delta (some providers nest text under .text or .delta.text)
              if (part?.type === 'output_text.delta') {
                const txt =
                  (typeof part?.text === 'string' ? part.text : '') ||
                  (typeof part?.delta?.text === 'string' ? part.delta.text : '');
                if (txt) pieces.push(txt);
              }
              // b) text_delta (alternate naming)
              if (part?.delta?.type === 'text_delta' && typeof part?.delta?.text === 'string') {
                pieces.push(part.delta.text);
              }
              // c) direct text value (rare in deltas but seen with some gateways)
              if (part?.type === 'text' && typeof part?.text?.value === 'string') {
                pieces.push(part.text.value);
              }
            }
          }

          // 2) Single delta object forms on the root
          if (!pieces.length && payloadObj?.delta) {
            const d = payloadObj.delta;
            if (d?.type === 'output_text.delta' && typeof d?.text === 'string') {
              pieces.push(d.text);
            } else if (d?.type === 'text_delta' && typeof d?.text === 'string') {
              pieces.push(d.text);
            } else if (typeof d?.text?.value === 'string') {
              pieces.push(d.text.value);
            }
          }

          // 3) responses-style array on root
          const deltasArr = payloadObj?.deltas;
          if (!pieces.length && Array.isArray(deltasArr)) {
            for (const d of deltasArr) {
              if (d?.type === 'output_text.delta' && typeof d?.text === 'string') {
                pieces.push(d.text);
              }
              if (d?.type === 'text_delta' && typeof d?.text === 'string') {
                pieces.push(d.text);
              }
            }
          }

          // 4) Fallbacks
          if (!pieces.length && typeof payloadObj?.text === 'string') {
            pieces.push(payloadObj.text);
          }
          if (!pieces.length && typeof payloadObj?.message?.content?.[0]?.text?.value === 'string') {
            pieces.push(payloadObj.message.content[0].text.value);
          }

          return pieces;
        };

        switch (eventName) {
          case 'thread.message.delta': {
            const pieces = extractDeltaPieces(payload || {});
            if (pieces.length) {
              for (const piece of pieces) {
                accText += piece;
                hadTokens = true;
                send('token', { delta: piece });
              }
            }
            break;
          }
          case 'message.delta': {
            const pieces = extractDeltaPieces(payload || {});
            if (pieces.length) {
              for (const piece of pieces) {
                accText += piece;
                hadTokens = true;
                send('token', { delta: piece });
              }
            }
            break;
          }
          case 'thread.message.completed': {
            if (payload?.id) lastAssistantMessageId = payload.id;
            // Some gateways attach the final content here; harvest if present
            try {
              const maybeText =
                (Array.isArray(payload?.message?.content) && payload.message.content
                  .map(p => (p?.type === 'text' && p?.text?.value) ? p.text.value : '')
                  .join('')) || '';
              if (maybeText) {
                accText += maybeText;
                hadTokens = true;
                send('token', { delta: maybeText });
              }
            } catch {}
            break;
          }
          case 'run.step.delta':
          case 'run.step.completed':
          case 'run.requires_action':
          case 'run.in_progress': {
            send('assistant.status', { stage: eventName });
            break;
          }
          case 'run.completed': {
            send('assistant.status', { stage: eventName });

            // Try to extract the used model from various possible payload shapes
            const usedModel =
              (payload && (payload.model || payload?.run?.model || payload?.response?.model || payload?.metadata?.model)) ||
              null;

            if (usedModel) {
              lastSeenModel = usedModel;
            }

            logger.info(
              `[STREAM] Run completed: thread=${threadId} plan=${userPlan} model=${usedModel || 'unknown'}`
            );
            break;
          }
          case 'error': {
            const msg = payload?.message || 'OpenAI stream error';
            if (!hadTokens) {
              // Only forward to client if nothing was streamed yet
              send('error', { message: msg });
            } else {
              // We already have content; just log and let finalization handle it.
              logger.warn('[STREAM] Error event received after tokens; suppressing to client:', msg);
            }
            break;
          }
          default:
            break;
        }
      }
    };

    stream.on('data', (chunk) => {
      try {
        buffer += chunk.toString('utf8');
        const lastSep = buffer.lastIndexOf('\n\n');
        if (lastSep !== -1) {
          const processPart = buffer.slice(0, lastSep);
          buffer = buffer.slice(lastSep + 2);
          flushBlocks(processPart);
        }
      } catch (e) {
        send('error', { message: e.message || 'Failed to parse stream chunk' });
      }
    });

    stream.on('end', async () => {
      // --- Post-end: if we haven't seen a model in-stream, query the latest run for model info and log plan+model
      try {
        if (!lastSeenModel) {
          const runsList = await axios.get(
            `https://api.openai.com/v1/threads/${threadId}/runs`,
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' } }
          );
          const latest = runsList.data?.data?.[0];
          if (latest) {
            lastSeenModel = latest.model || latest.response?.model || lastSeenModel;
            logger.info(
              `[STREAM] Run (post-end) info: thread=${threadId} plan=${userPlan} model=${lastSeenModel || 'unknown'} status=${latest.status}`
            );
          } else {
            logger.info(`[STREAM] Run (post-end) info: thread=${threadId} plan=${userPlan} model=unknown (no runs found)`);
          }
        } else {
          logger.info(`[STREAM] Run (post-end) info: thread=${threadId} plan=${userPlan} model=${lastSeenModel}`);
        }
      } catch (e) {
        logger.warn('[STREAM] Nem sikerült utólag lekérdezni a run-t a modellhez:', e?.message);
      }
      // Small grace period to allow OpenAI to persist the final assistant message
      try { await delay(800); } catch {}
      try {
        // 🔁 Final fallback: if no deltas were captured, fetch the latest assistant message
        if (!accText || !accText.trim()) {
          // Try up to 6 times with 500ms delay to let OpenAI persist the final assistant message
          let attempts = 0;
          let fetchedText = '';
          while (attempts < 6 && !fetchedText) {
            attempts++;
            try {
              const msgResp = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, {
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                  'OpenAI-Beta': 'assistants=v2'
                }
              });
              const assistantMsg = msgResp.data?.data?.find(m => m.role === 'assistant');
              if (assistantMsg?.content) {
                let fallbackTxt = '';
                if (Array.isArray(assistantMsg.content)) {
                  for (const item of assistantMsg.content) {
                    if (item?.type === 'text' && typeof item?.text?.value === 'string') {
                      fallbackTxt += item.text.value;
                    }
                  }
                }
                if (!fallbackTxt && typeof assistantMsg?.content === 'string') {
                  fallbackTxt = assistantMsg.content;
                }
                if (fallbackTxt) {
                  fetchedText = fallbackTxt;
                  if (assistantMsg?.id && !lastAssistantMessageId) {
                    lastAssistantMessageId = assistantMsg.id;
                  }
                  break;
                }
              }
            } catch (e) {
              logger.warn('[STREAM] Fallback fetch of messages failed (attempt ' + attempts + '):', e?.message);
            }
            try { await delay(500); } catch {}
          }
          if (fetchedText) {
            accText = fetchedText;
          }
        }
        const cleaned = (accText || '').replace(/【.*?】/g, '');
        const sanitized = sanitizeHtml(cleaned, {
          allowedTags: ['a','b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td'],
          allowedAttributes: { 'span': ['class'], 'a': ['href','title','target','rel'] },
          transformTags: {
            'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true)
          },
          disallowedTagsMode: 'discard'
        });
        let finalHtml = marked(sanitized);
        if (finalCategory) {
          finalHtml = finalHtml.replace(/<h3>According to the document:<\/h3>/, `<h3>According to ${finalCategory}:<\/h3>`);
        }

        // Persist user + assistant messages
        conversation.messages.push({ role: 'user', content: message, ...(finalCategory && { category: finalCategory }) });
        conversation.messages.push({ role: 'assistant', content: finalHtml });
        await conversation.save();
        const savedAssistant = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

        send('final', { html: finalHtml, messageId: savedAssistant?._id || lastAssistantMessageId || null });
      } catch (e) {
        send('error', { message: e.message || 'Failed to finalize message' });
      } finally {
        send('done', { ok: true });
        res.end();
      }
    });

    stream.on('error', (err) => {
      send('error', { message: err?.message || 'OpenAI stream connection error' });
      try { res.end(); } catch {}
    });

  } catch (error) {
    // If streaming fails early, report and close
    logger.error('[STREAM] Hiba az üzenetküldés során:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status,
    });
    // Extra detail for non-JSON or opaque error bodies
    if (error?.response) {
      const hdrs = error.response.headers || {};
      const reqId = hdrs['x-request-id'] || hdrs['openai-request-id'] || hdrs['request-id'] || null;
      let raw = '';
      try {
        if (typeof error.response.data === 'string') raw = error.response.data;
        else if (Buffer.isBuffer(error.response.data)) raw = error.response.data.toString('utf8');
        else raw = JSON.stringify(error.response.data);
      } catch (_) {
        raw = String(error.response.data || '');
      }
      logger.error(`[STREAM] error response headers: reqId=${reqId || 'n/a'} content-type=${hdrs['content-type'] || 'n/a'}`);
      logger.error(`[STREAM] error raw body (first 2KB): ${raw.slice(0, 2048)}`);
    }
    if (error?.response?.status === 400) {
      try {
        logger.error(`[STREAM] 400 detailed body: ${JSON.stringify(error.response.data)}`);
      } catch (_) {
        logger.error(`[STREAM] 400 detailed text: ${String(error?.response?.data || error.message)}`);
      }
    }
    try {
      send('error', { message: error.message || 'Váratlan hiba történt.' });
      send('done', { ok: false });
    } finally {
      return res.end();
    }
  }
};
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
const Tenant = require('../models/tenant');
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

// In-memory concurrency guard for uploadAndAskStream
const activeAskThreads = new Set();


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
    conversation = await Conversation.findOne({ threadId, userId, tenantId: (req.scope?.tenantId || undefined) });
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
    const user = await User.findById(userId).select('tenantId');
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    if (!tenantId) {
      send('error', { message: 'Hiányzó tenant azonosító.' });
      send('done', { ok: false });
      return res.end();
    }
    if (!user) {
      send('error', { message: 'Felhasználó nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    const tenantDoc = await Tenant.findById(tenantId).select('name');
    if (!tenantDoc) {
      send('error', { message: 'Tenant nem található.' });
      send('done', { ok: false });
      return res.end();
    }
    const tenantKey = String(tenantDoc.name || '').toLowerCase();
    const assistantId = assistants.byTenant?.[tenantKey] || assistants['default'];
    // DEBUG: Assistant selection trace (UPLOAD_SUMMARY)
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] req.scope.tenantId:', req.scope?.tenantId);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] user.tenantId:', user?.tenantId ? String(user.tenantId) : null);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] resolved tenantId:', tenantId);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] tenantDoc:', { id: tenantDoc?._id, name: tenantDoc?.name });
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] tenantKey:', tenantKey);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] assistants.byTenant keys:', Object.keys(assistants.byTenant || {}));
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] assistants.byTenant[tenantKey]:', (assistants.byTenant || {})[tenantKey] || null);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] default assistantId:', assistants['default']);
    logger.debug('[ASSISTANT PICK][UPLOAD_SUMMARY] chosen assistantId:', assistantId);

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
    const { finalHtml, injectedUserMessageId } = await runUploadAndSummarize(
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

    // 1) add the meta/user message first (as if user wrote a prompt about the upload)
    conversation.messages.push({ role: 'user', content: metaUserMsg });

    // 2) use the finalHtml produced by gpt-5-mini directly as the assistant reply
    const assistantHtmlToStore = finalHtml;

    // Log the entire assistant answer for debugging / comparison
    try {
      const fullLen = (assistantHtmlToStore || '').length;
      const shortPreview = (assistantHtmlToStore || '').replace(/\s+/g, ' ').slice(0, 200);
      logger.info(`[SUMMARY] Storing assistant summary into DB | thread=${conversation.threadId} len=${fullLen} preview="${shortPreview}"`);
      logger.debug(`[SUMMARY] FULL_ASSISTANT_HTML_BEGIN\n${assistantHtmlToStore}\nFULL_ASSISTANT_HTML_END`);
      if (typeof injectedUserMessageId === 'string' && injectedUserMessageId.length) {
        logger.info(`[SUMMARY] Context-only USER message injected into thread: ${injectedUserMessageId}`);
      }
    } catch (e) {
      logger.warn('[SUMMARY] Failed to log full assistant HTML:', e?.message);
    }

    // 3) store the assistant message in DB exactly like normal chat replies
    conversation.messages.push({
      role: 'assistant',
      content: assistantHtmlToStore,
      images: []
    });
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
    send('final', { html: assistantHtmlToStore, messageId: lastAssistantMessage?._id || null });
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

// ===== Upload-and-Ask (FULL CONTENT QA) – SSE =====
// This endpoint takes up to 10 uploaded files + a question,
// extracts FULL plaintext context (token-limited), asks gpt-5-mini,
// streams progress, and saves both the user question and the assistant reply into the same conversation.
exports.uploadAndAskStream = [
  upload.array('files', 10), // limit to 10 files
  async (req, res) => {
    const send = sseInit(req, res);
    let conversation; // visible in catch
    let threadId;
    try {
      const userId = req.userId;
      const files = req.files || [];
      // Read question in new flexible way
      const { threadId: tid, question: rawQuestion, userQuestion } = req.body || {};
      threadId = tid;
      const question = (typeof userQuestion === 'string' && userQuestion.trim()) ? userQuestion : (typeof rawQuestion === 'string' ? rawQuestion : '');

      if (!userId) {
        send('error', { message: 'Hiányzó vagy érvénytelen JWT.' });
        send('done', { ok: false });
        return res.end();
      }
      if (!threadId || typeof threadId !== 'string' || !threadId.trim()) {
        send('error', { message: 'threadId kötelező.' });
        send('done', { ok: false });
        return res.end();
      }
      if (!question || !String(question).trim()) {
        send('error', { message: 'A question kötelező, nem lehet üres.' });
        send('done', { ok: false });
        return res.end();
      }
      if (!files.length) {
        send('error', { message: 'Nincs feltöltött fájl.' });
        send('done', { ok: false });
        return res.end();
      }
      // ---- Concurrency guard ----
      if (activeAskThreads.has(threadId)) {
        send('error', { message: 'Ezen a szálon már fut egy fájl-alapú kérdés feldolgozás.' });
        send('done', { ok: false });
        return res.end();
      }
      activeAskThreads.add(threadId);

      try {
        // Validate conversation ownership
        conversation = await Conversation.findOne({
          threadId,
          userId,
          tenantId: (req.scope?.tenantId || undefined)
        });
        if (!conversation) {
          send('error', { message: 'A beszélgetés nem található vagy nem hozzáférhető.' });
          send('done', { ok: false });
          return res.end();
        }
        // Only one background job at a time per conversation (soft rule, not a job here, just a check)
        if (conversation.job && conversation.job.status === 'running') {
          send('error', { message: 'Már fut egy háttérfeladat ezen a beszélgetésen.' });
          send('done', { ok: false });
          return res.end();
        }

        send('info', { stage: 'start', message: 'Olvasás/kinyerés indul.' });

        // ---------- Helpers (scoped) ----------
        const tokLen = (s = '') => encoder.encode(String(s)).length;
        const trimToTokens = (text, maxTokens) => {
          const ids = encoder.encode(text || '');
          return encoder.decode(ids.slice(0, maxTokens));
        };

        async function extractFileToText(file, baseUrl) {
          const mt = (file.mimetype || '').toLowerCase();
          try {
            // PDF -> internal pdfcert
            if (mt === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
              const form = new FormData();
              form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype || 'application/pdf' });
              form.append('certType', 'ATEX'); // nálatok meglévő végpont így használja; igény szerint elhagyható
              const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, { headers: form.getHeaders(), timeout: 300000 });
              return String(resp.data?.recognizedText || '');
            }
            // Images -> vision upload + analyze
            if (mt.startsWith('image/')) {
              const form = new FormData();
              form.append('image', file.buffer, { filename: file.originalname, contentType: file.mimetype || 'application/octet-stream' });
              const uploadResp = await axiosClient.post(`${baseUrl}/api/vision/upload`, form, { headers: form.getHeaders(), timeout: 300000 });
              const imageUrl = uploadResp.data?.image_url;
              if (!imageUrl) return '';
              const analyzeResp = await axiosClient.post(`${baseUrl}/api/vision/analyze`, {
                image_urls: [imageUrl],
                user_input: 'Extract all readable text and labels. If tables appear, describe them row-wise.'
              }, { timeout: 300000, headers: { 'Content-Type': 'application/json' } });
              return String(analyzeResp.data?.result || '');
            }
            // DOCX
            if (mt.includes('wordprocessingml') || file.originalname.toLowerCase().endsWith('.docx')) {
              const out = await mammoth.extractRawText({ buffer: file.buffer });
              return out.value || '';
            }
            // Legacy DOC
            if (mt.includes('msword') || file.originalname.toLowerCase().endsWith('.doc')) {
              try { return file.buffer.toString('utf8'); } catch { return ''; }
            }
            // XLS/XLSX
            if (
              mt.includes('excel') || mt.includes('spreadsheetml') ||
              file.originalname.toLowerCase().endsWith('.xls') ||
              file.originalname.toLowerCase().endsWith('.xlsx')
            ) {
              const wb = xlsx.read(file.buffer, { type: 'buffer' });
              const parts = [];
              wb.SheetNames.forEach(sheet => {
                const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false });
                parts.push(`-- SHEET: ${sheet} --\n${csv}`);
              });
              return parts.join('\n\n');
            }
            // TXT / fallback
            if (mt === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
              return file.buffer.toString('utf8');
            }
            try { return file.buffer.toString('utf8'); } catch { return ''; }
          } catch {
            return '';
          }
        }

        // ---------- Build full context (token-limited) ----------
        const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
        const parts = [];
        let totalChars = 0;

        for (const f of files.slice(0, 10)) {
          send('progress', { stage: 'file.read', file: f.originalname });
          const txt = await extractFileToText(f, baseUrl);
          const cleaned = (txt || '').replace(/\u0000/g, '');
          parts.push(`### ${f.originalname}\n${cleaned}`);
          totalChars += cleaned.length;
          send('progress', { stage: 'file.done', file: f.originalname, chars: cleaned.length });
        }
        send('progress', { stage: 'files.done', count: parts.length, totalChars });

        // ---------- Build full context (token-limited, CHUNKED MAP-REDUCE) ----------
        const header = `You will answer based ONLY on the following documents. Cite exact passages when possible.\n\n`;
        const joined = parts.join('\n\n---\n\n');

        // Safe overall caps (we will process ALL chunks; no hard MAX_CHUNKS cap)
        const HARD_INPUT_CAP = Math.max(80_000, parseInt(process.env.UPLOAD_ASK_INPUT_CAP || '120000', 10)); // per reduce round
        const MAP_CHUNK_SIZE = Math.max(1500, parseInt(process.env.QA_CHUNK_TOKENS || '3000', 10)); // per-map chunk input tokens
        // No MAX_CHUNKS: we iterate over all tokens to guarantee full coverage

        const totalTokens = tokLen(joined);
        send('progress', { stage: 'combined.start', files: parts.length, totalTokens });

        // Break the context into manageable token chunks (NO hard cap on chunk count)
        const ids = encoder.encode(joined);
        const chunks = [];
        for (let i = 0; i < ids.length; i += MAP_CHUNK_SIZE) {
          chunks.push(encoder.decode(ids.slice(i, i + MAP_CHUNK_SIZE)));
        }
        send('progress', { stage: 'combined.chunk', index: 0, total: chunks.length });

        const modelPrimary = process.env.SUMMARY_COMPLETIONS_MODEL || 'gpt-5-mini';
        const modelFallback = process.env.SUMMARY_COMPLETIONS_FALLBACK || 'gpt-4o-mini';

        const systemMap = [
          'You are a precise technical assistant.',
          'Only use the provided CONTEXT CHUNK.',
          'If the answer cannot be found in this chunk, say exactly: "Not found in this chunk."',
          'Otherwise, extract the **minimal necessary** quotes (with line excerpts) and mention the source filename shown in the chunk header.',
        ].join(' ');

        const systemReduce = [
          'You are a precise technical assistant.',
          'Synthesize the final answer ONLY from the provided FINDINGS.',
          'If contradictory, choose the most specific and directly quoted evidence.',
          'If overall not present, say: "Not found in provided files."',
          'Cite exact lines and list the source filename(s).',
        ].join(' ');

        // Per-request retry with backoff + jitter (shared by map & reduce)
        async function chatWithRetry(modelName, messages, stageLabel) {
          const MAX = 6;
          let attempt = 0;
          let wait = 500;
          const jitter = (ms) => ms + Math.floor(Math.random() * 150);

          while (attempt < MAX) {
            attempt++;
            try {
              const payload = { model: modelName, messages };
              const resp = await axiosClient.post('https://api.openai.com/v1/chat/completions', payload, {
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
              });
              return resp.data?.choices?.[0]?.message?.content || '';
            } catch (err) {
              const status = err?.response?.status || 0;
              const retriable = status === 429 || (status >= 500 && status < 600);
              if (!retriable || attempt >= MAX) {
                // announce terminal failure
                try { send('assistant.status', { stage: `${stageLabel}.fail`, model: modelName, status, error: err?.message || 'error' }); } catch {}
                throw err;
              }
              let pause = wait;
              const ra = err?.response?.headers?.['retry-after'];
              if (ra) {
                const raMs = Number(ra) * 1000;
                if (!Number.isNaN(raMs) && raMs > 0) pause = Math.max(pause, raMs);
              }
              try { send('assistant.status', { stage: `${stageLabel}.retry`, attempt, waitMs: pause, status }); } catch {}
              await delay(jitter(pause));
              wait = Math.min(wait * 2, 8000);
            }
          }
          return '';
        }

        // Map stage: collect findings per chunk
        const findings = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i];
          send('progress', { stage: 'combined.chunk', index: i + 1, total: chunks.length });

          const mapMessages = [
            { role: 'system', content: systemMap },
            { role: 'user', content: `CONTEXT CHUNK:\n\n${header}${chunkText}\n\nQUESTION:\n${question}` }
          ];

          let reply = '';
          try {
            reply = await chatWithRetry(modelPrimary, mapMessages, 'map.primary');
            send('assistant.status', { stage: 'map.primary.ok', index: i + 1, total: chunks.length, model: modelPrimary });
            // small heartbeat for UI typing feel
            try { send('token', { delta: '\n' }); } catch {}
          } catch {
            reply = await chatWithRetry(modelFallback, mapMessages, 'map.fallback');
            send('assistant.status', { stage: 'map.fallback.ok', index: i + 1, total: chunks.length, model: modelFallback });
            try { send('token', { delta: '\n' }); } catch {}
          }

          const normalized = (reply || '').trim();
          findings.push(`### CHUNK ${i + 1}/${chunks.length}\n${normalized}`);
          // Stream the map result lightly as a progress delta (optional UX)
          // (heartbeat now handled above)
        }

        // ---------- Hierarchical reduce: iteratively summarize all findings in batches until under cap ----------
        async function hierarchicalReduce(allFindings, systemReduce, question, modelPrimary, modelFallback) {
          // allFindings: array of strings (findings from map)
          // We will pack findings into batches so that each reduce call stays under HARD_INPUT_CAP tokens.
          const MAX_ROUNDS = 10; // safety
          let round = 0;
          let current = allFindings.slice();

          while (true) {
            round++;
            if (round > MAX_ROUNDS) {
              // last-resort: join and trim (should be unreachable in normal sizes)
              let fj = current.join('\n\n---\n\n');
              if (tokLen(fj) > HARD_INPUT_CAP) fj = trimToTokens(fj, HARD_INPUT_CAP);
              return fj;
            }

            // If everything already fits in one go, reduce once and return
            let joinedCandidate = current.join('\n\n---\n\n');
            if (tokLen(joinedCandidate) <= HARD_INPUT_CAP) {
              const reduceMessagesFinal = [
                { role: 'system', content: systemReduce },
                { role: 'user', content: `FINDINGS (from multiple chunks):\n\n${joinedCandidate}\n\nFINAL QUESTION:\n${question}` }
              ];
              send('assistant.status', { stage: 'assistant.start', round });
              try {
                const out = await chatWithRetry(modelPrimary, reduceMessagesFinal, `reduce.primary.round${round}`);
                send('assistant.status', { stage: `reduce.primary.ok`, model: modelPrimary, round });
                return out;
              } catch {
                const out = await chatWithRetry(modelFallback, reduceMessagesFinal, `reduce.fallback.round${round}`);
                send('assistant.status', { stage: `reduce.fallback.ok`, model: modelFallback, round });
                return out;
              }
            }

            // Otherwise, split into batches that fit under the cap
            const batches = [];
            let batch = [];
            let batchTok = 0;
            for (const item of current) {
              const cost = tokLen(item) + 8; // small overhead between items
              if (batchTok + cost > HARD_INPUT_CAP && batch.length) {
                batches.push(batch);
                batch = [item];
                batchTok = tokLen(item);
              } else {
                batch.push(item);
                batchTok += cost;
              }
            }
            if (batch.length) batches.push(batch);

            send('assistant.status', { stage: 'reduce.round.start', round, batches: batches.length });

            // Reduce each batch to an intermediate summary
            const next = [];
            for (let i = 0; i < batches.length; i++) {
              const b = batches[i];
              let bJoined = b.join('\n\n---\n\n');
              if (tokLen(bJoined) > HARD_INPUT_CAP) {
                bJoined = trimToTokens(bJoined, HARD_INPUT_CAP);
              }
              const msg = [
                { role: 'system', content: systemReduce },
                { role: 'user', content: `FINDINGS (batch ${i+1}/${batches.length}):\n\n${bJoined}\n\nQUESTION:\n${question}\n\nReturn a concise, well-structured summary WITH exact quotes and source filenames.` }
              ];
              let summary = '';
              try {
                summary = await chatWithRetry(modelPrimary, msg, `reduce.primary.batch${i+1}.round${round}`);
                send('assistant.status', { stage: 'reduce.primary.ok', model: modelPrimary, round, batch: i + 1 });
              } catch {
                summary = await chatWithRetry(modelFallback, msg, `reduce.fallback.batch${i+1}.round${round}`);
                send('assistant.status', { stage: 'reduce.fallback.ok', model: modelFallback, round, batch: i + 1 });
              }
              next.push(summary.trim());
              // lightweight progress ping for UI
              try { send('token', { delta: '\n' }); } catch {}
            }

            // Prepare for next round with the intermediate summaries
            current = next;
            send('assistant.status', { stage: 'reduce.round.end', round, producedSummaries: current.length });
          }
        }

        // ---------- Hierarchical reduce over ALL findings ----------
        send('tokens.update', { used: tokLen(findings.join('\n\n---\n\n')), limit: HARD_INPUT_CAP });
        const combinedText = await hierarchicalReduce(findings, systemReduce, question, modelPrimary, modelFallback);

        const cleaned = String(combinedText || '').trim().replace(/【.*?】/g, '');
        const sanitized = sanitizeHtml(cleaned, {
          allowedTags: ['a','b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td'],
          allowedAttributes: { 'span': ['class'], 'a': ['href','title','target','rel'] },
          transformTags: {
            'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true)
          },
          disallowedTagsMode: 'discard'
        });
        const finalHtml = marked(sanitized);

        // ---------- Persist into conversation (user Q + assistant A) ----------
        try {
          conversation.messages.push({ role: 'user', content: question, meta: { kind: 'upload-and-ask', fileCount: files.length } });
          conversation.messages.push({ role: 'assistant', content: finalHtml, images: [] });
          await conversation.save();
          const lastAssistant = conversation.messages.slice().reverse().find(m => m.role === 'assistant');
          send('tokens.final', { used: null, limit: null });
          send('final', { html: finalHtml, messageId: lastAssistant?._id || null });
        } catch (e) {
          send('error', { message: e?.message || 'Nem sikerült menteni a választ.' });
        } finally {
          send('done', { ok: true });
          return res.end();
        }
      } finally {
        activeAskThreads.delete(threadId);
      }
    } catch (error) {
      // Log error
      logger.error('Hiba az upload-and-ask folyamatban:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data,
        status: error.response?.status,
      });
      try {
        send('error', { message: error.message || 'Váratlan hiba történt.' });
        send('done', { ok: false });
      } finally {
        if (threadId) activeAskThreads.delete(threadId);
        return res.end();
      }
    }
  }
];

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
      userId,
      tenantId: req.scope?.tenantId || undefined,
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

      const user = await User.findById(userId).select('tenantId');
      const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
      if (!tenantId) {
        return res.status(403).json({ error: 'Hiányzó tenant azonosító.' });
      }
      if (!user) {
        return res.status(404).json({ error: 'Felhasználó nem található.' });
      }

      const tenantDoc = await Tenant.findById(tenantId).select('name');
      if (!tenantDoc) {
        return res.status(404).json({ error: 'Tenant nem található.' });
      }
      const tenantKey = String(tenantDoc.name || '').toLowerCase();
      const assistantId = assistants.byTenant?.[tenantKey] || assistants['default'];

      // Determine user plan (best effort) and log context
      // 1) Try req.auth.subscription?.plan (auth controller attaches subscription snapshot)
      // 2) Fallbacks to req.user.subscription?.tier, req.user.plan, req.auth.subscription?.tier, req.auth.plan, req.scope.plan
      // 3) Final fallback: query DB (Subscription / Tenant) by tenantId
      let userPlan =
        (req.auth && req.auth.subscription?.plan) ||
        (req.user && (req.user.subscription?.tier || req.user.plan)) ||
        (req.auth && (req.auth.subscription?.tier || req.auth.plan)) ||
        (req.scope && req.scope.plan) ||
        null;

      if (!userPlan) {
        try {
          const subDoc = await Subscription.findOne({ tenantId }).select('tier');
          const tenDoc = await Tenant.findById(tenantId).select('plan');
          userPlan = (subDoc?.tier || tenDoc?.plan || 'unknown');
          if (userPlan !== 'unknown') {
            logger.info(`[CHAT] Plan resolved via DB fallback: plan=${userPlan}`);
          }
        } catch (e) {
          userPlan = 'unknown';
          logger.warn('[CHAT] Failed to resolve plan from DB fallback:', e?.message);
        }
      }
      logger.info(`[CHAT] Context: thread=${threadId} tenant=${tenantKey} plan=${userPlan} assistantId=${assistantId}`);

      let applicableInjection = null;
      if (tenantKey === 'wolff' || assistantId === process.env.ASSISTANT_ID_WOLFF) {
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

      const conversation = await Conversation.findOne({ threadId, userId, tenantId });
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

      // ---- Prepare run payload (non-stream, no model override) ----
      const baseRunPayload = { assistant_id: assistantId };

      // Optional instructions if injection is active
      let finalInstructions = null;
      if (applicableInjection) {
        const assistantData = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        const assistantPrompt = assistantData.data.instructions || '';
        finalInstructions = `${assistantPrompt}\n\nAlways put the following sentence at the end of the explanation part as a <strong>Note:</strong>, exactly as written, in a separate paragraph between <em> tags: :\n\n"${applicableInjection}"`;
        logger.info('📋 Final instructions before sending:', finalInstructions);
      }

      // Create run (no model override; use assistant default)
      const payload = { ...baseRunPayload, ...(finalInstructions ? { instructions: finalInstructions } : {}) };
      const runResponse = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      });
      logger.info(`[CHAT] Using assistant default model (no override).`);

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

      // Log the final used model for this run
      try {
        const finalRunResp = await axios.get(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runResponse.data.id}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2',
            },
          }
        );
        const usedModel = finalRunResp.data?.model || finalRunResp.data?.response?.model || 'unknown';
        logger.info(`[CHAT] Run completed: thread=${threadId} plan=${userPlan} model=${usedModel}`);
      } catch (e) {
        logger.warn(`[CHAT] Could not fetch final run model: ${e?.message}`);
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
      if (error?.response) {
        const hdrs = error.response.headers || {};
        const reqId = hdrs['x-request-id'] || hdrs['openai-request-id'] || hdrs['request-id'] || null;
        let raw = '';
        try {
          if (typeof error.response.data === 'string') raw = error.response.data;
          else if (Buffer.isBuffer(error.response.data)) raw = error.response.data.toString('utf8');
          else raw = JSON.stringify(error.response.data);
        } catch (_) {
          raw = String(error.response.data || '');
        }
        logger.error(`[CHAT] error response headers: reqId=${reqId || 'n/a'} content-type=${hdrs['content-type'] || 'n/a'}`);
        logger.error(`[CHAT] error raw body (first 2KB): ${raw.slice(0, 2048)}`);
      }
      if (error?.response?.status === 400) {
        try {
          logger.error(`[CHAT] 400 detailed body: ${JSON.stringify(error.response.data)}`);
        } catch (_) {}
        logger.error(`[CHAT] 400 detailed text: ${String(error?.response?.data || error.message)}`);
      }
      res.status(500).json({ error: 'Váratlan hiba történt.' });
    }
  }
];




// Üzenet értékelése
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

// Beszélgetés törlése
exports.deleteConversation = async (req, res) => {
  const { threadId } = req.params;
  try {
    const conversation = await Conversation.findOneAndDelete({ threadId, userId: req.userId, tenantId: (req.scope?.tenantId || undefined) });

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
    const conversations = await Conversation.find({ userId, tenantId: (req.scope?.tenantId || undefined) });  // Csak a bejelentkezett user beszélgetései tenant szerint
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