const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const crypto = require('crypto');
const logger = require('../config/logger');
const InjectionRule = require('../models/injectionRule');
const { resolveUserAndTenant, resolveAssistantForTenant, ensureConversationOwnership } = require('../services/chatAccessService');
const { resolveUserPlan } = require('../services/chatContextService');
const { initSse } = require('../services/sseService');
const { getStyleInstructions, buildTabularHint, buildRollingSummary, getTenantAiProfileCached } = require('../services/chatPromptService');
const { categorizeMessageUsingAI } = require('../helpers/categorizeMessage');
const { extractOutputTextFromResponse } = require('../helpers/openaiResponses');
const { createResponseStream } = require('../helpers/openaiResponses');
const tenantSettingsStore = require('../services/tenantSettingsStore');

// Best-effort concurrency guard (single process). Prevents overlapping model calls per conversation.
const inFlightByThreadId = new Set();

function sha256Short(text) {
  try {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function normalizeFileIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter((item) => /^file-[A-Za-z0-9_-]+$/.test(item))
    .slice(0, 10);
}

function buildResponseInput(message, fileIds) {
  if (!fileIds.length) return [{ role: 'user', content: message }];
  return [{
    role: 'user',
    content: [
      ...fileIds.map((fileId) => ({ type: 'input_file', file_id: fileId })),
      { type: 'input_text', text: message },
    ],
  }];
}

async function handleSendMessageStream(req, res) {
  const send = initSse(req, res);

  try {
    const { message, threadId, category, vectorStoreId } = req.body || {};
    const fileIds = normalizeFileIds(req.body?.fileIds);
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
    let user;
    let tenantId;
    let tenantKey;
    let source;
    try {
      const resolved = await resolveUserAndTenant(req);
      user = resolved.user;
      tenantId = resolved.tenantId;
      const assistantCtx = await resolveAssistantForTenant(tenantId, 'STREAM');
      tenantKey = assistantCtx.tenantKey;
      source = assistantCtx.source;
    } catch (e) {
      send('error', { message: e?.message || 'Váratlan hiba történt.' });
      send('done', { ok: false });
      return res.end();
    }
    logger.debug('[ASSISTANT PICK][STREAM_EXTRA]', {
      reqTenantId: req.scope?.tenantId || null,
      userTenantId: user?.tenantId ? String(user.tenantId) : null,
      tenantId,
      tenantKey,
      source,
      assistantId: null
    });

    // ---- Determine user plan (best-effort) ----
    const userPlan = await resolveUserPlan(req, tenantId, logger);
    logger.info(
      `[STREAM] Context: thread=${threadId} tenant=${tenantKey} plan=${userPlan}`
    );

    // ---- Optional injection rules (Wolff) ----
    let applicableInjection = null;
    if (tenantKey === 'wolff') {
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
    let conversation;
    try {
      conversation = await ensureConversationOwnership({ threadId, userId, tenantId });
    } catch (e) {
      send('error', { message: e?.message || 'A megadott szál nem található.' });
      send('done', { ok: false });
      return res.end();
    }

    // ---- Concurrency guard (single process) ----
    if (inFlightByThreadId.has(threadId)) {
      send('error', { message: 'Már fut egy aktív feldolgozás. Kérlek, várj amíg véget ér.' });
      send('done', { ok: false });
      return res.end();
    }
    inFlightByThreadId.add(threadId);

    // ---- Prepare Responses payload (store:true + previous_response_id chaining) ----
    // Build a concise rolling summary of the conversation so far (tone/continuity aid; not evidence)
    const rolling = await buildRollingSummary(conversation).catch(() => '');
    const convBlock = rolling ? `\n\nCONVERSATION SUMMARY (for context—do not use as evidence):\n${rolling}\n` : '';

    const styleForPlain = getStyleInstructions('plain');
    const tabularHint = buildTabularHint(message);

    // IMPORTANT:
    // With Responses API + previous_response_id, instructions from a previous response are not carried over.
    // So we must send the assistant persona (instructions) every time.
    const tenantAi = await getTenantAiProfileCached(tenantId);
    const assistantPrompt = String(tenantAi?.instructions || '');
    const baseInstructions = `${assistantPrompt}\n\n${styleForPlain}${convBlock}`.trim();

    let finalInstructions = baseInstructions;
    if (tabularHint) finalInstructions = `${finalInstructions}\n\n${tabularHint}`;
    if (fileIds.length) {
      finalInstructions = `${finalInstructions}\n\nThe user attached files directly to this message. Treat those attached files as the primary subject of the answer. You may use the tenant knowledge base only as supporting reference when it is relevant, and clearly distinguish uploaded-file facts from knowledge-base context.`;
    }
    if (vectorStoreId && typeof vectorStoreId === 'string' && vectorStoreId.trim()) {
      finalInstructions = `${finalInstructions}\n\nUse the uploaded file_search documents as the primary evidence for this answer. If the answer is not present in the uploaded documents, say that it is not found in the uploaded file instead of answering from general knowledge.`;
    }
    if (applicableInjection) {
      finalInstructions =
        `${finalInstructions}\n\n` +
        'Always put the following sentence at the end of the explanation part as a <strong>Note:</strong>, ' +
        'exactly as written, in a separate paragraph between <em> tags: :\n\n' +
        `"${applicableInjection}"`;
    }

    const model = String(tenantAi?.model || conversation?.lastModel || 'gpt-5-mini').trim() || 'gpt-5-mini';

    const payload = {
      model,
      stream: true,
      store: true,
      instructions: finalInstructions,
      input: buildResponseInput(message, fileIds),
      ...(conversation?.lastResponseId ? { previous_response_id: String(conversation.lastResponseId) } : {}),
      ...(vectorStoreId && typeof vectorStoreId === 'string' && vectorStoreId.trim()
        ? { tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId.trim()] }] }
        : (tenantAi?.kbVectorStoreId
          ? { tools: [{ type: 'file_search', vector_store_ids: [String(tenantAi.kbVectorStoreId)] }] }
          : {})),
    };

    const chatTuning = await tenantSettingsStore.getChatTuning(tenantId).catch(() => ({
      temperature: 0,
      topP: null,
      maxOutputTokens: 2500,
      truncation: null,
      reasoningEffort: null,
    }));

    const usedVectorStoreId =
      (vectorStoreId && typeof vectorStoreId === 'string' && vectorStoreId.trim())
        ? vectorStoreId.trim()
        : (tenantAi?.kbVectorStoreId ? String(tenantAi.kbVectorStoreId) : null);
    const vectorStoreSource =
      (vectorStoreId && typeof vectorStoreId === 'string' && vectorStoreId.trim())
        ? 'request'
        : (tenantAi?.kbVectorStoreId ? 'tenant' : 'none');

    logger.info('chat.responses.applied_settings', {
      requestId: req.requestId || null,
      threadId,
      tenantId,
      tenantKey,
      plan: userPlan,
      model,
      previousResponseId: conversation?.lastResponseId ? String(conversation.lastResponseId) : null,
      vectorStoreId: usedVectorStoreId,
      vectorStoreSource,
      attachedFileCount: fileIds.length,
      temperature: chatTuning.temperature,
      topP: chatTuning.topP,
      maxOutputTokens: chatTuning.maxOutputTokens,
      truncation: chatTuning.truncation,
      reasoningEffort: chatTuning.reasoningEffort,
      assistantInstructionsChars: assistantPrompt.length,
      assistantInstructionsSha: sha256Short(assistantPrompt),
      finalInstructionsChars: finalInstructions.length,
      finalInstructionsSha: sha256Short(finalInstructions),
    });

    // ---- OpenAI SSE stream (Responses API) ----
    const openaiStream = await createResponseStream({
      model: payload.model,
      instructions: payload.instructions,
      input: payload.input,
      previousResponseId: payload.previous_response_id || null,
      tools: payload.tools || null,
      store: true,
      temperature: chatTuning.temperature,
      topP: chatTuning.topP,
      maxOutputTokens: chatTuning.maxOutputTokens,
      truncation: chatTuning.truncation,
      reasoningEffort: chatTuning.reasoningEffort,
      timeoutMs: 0,
    });
    logger.info(`[STREAM] Responses stream started: thread=${threadId} model=${model} previous=${conversation?.lastResponseId || 'none'}`);
    send('assistant.status', { stage: 'openai.stream.start' });

    let accText = '';
    let lastResponseId = null;
    const stream = openaiStream;
    let buffer = '';
    let hadTokens = false;
    let lastSeenModel = null;
    let lastResponseObj = null;

    const flushBlocks = (raw) => {
      const blocks = raw.split('\n\n');
      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let eventName = null; // may be absent in some SSE implementations
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (dataStr === '[DONE]') continue;

        let payloadObj = null;
        try { payloadObj = dataStr ? JSON.parse(dataStr) : null; } catch { payloadObj = null; }
        const t = eventName || payloadObj?.type || null;
        if (!t) continue;

        switch (t) {
          case 'response.created':
          case 'response.in_progress':
          case 'response.output_item.added':
          case 'response.output_item.done':
          case 'response.content_part.added':
          case 'response.content_part.done':
          case 'response.file_search_call.in_progress':
          case 'response.file_search_call.searching':
          case 'response.file_search_call.completed': {
            send('assistant.status', { stage: t });
            // Capture response object if present for later fallback
            if (payloadObj?.response) lastResponseObj = payloadObj.response;
            break;
          }
          case 'response.output_text.delta': {
            const piece = typeof payloadObj?.delta === 'string' ? payloadObj.delta : '';
            if (piece) {
              accText += piece;
              hadTokens = true;
              send('token', { delta: piece });
            }
            break;
          }
          case 'response.output_text.done': {
            const piece = typeof payloadObj?.text === 'string' ? payloadObj.text : '';
            if (piece && !accText.includes(piece)) {
              // Defensive: if deltas were not captured, append final text.
              accText += piece;
              hadTokens = true;
              send('token', { delta: piece });
            }
            break;
          }
          case 'response.completed': {
            send('assistant.status', { stage: t });
            const resp = payloadObj?.response || null;
            if (resp) lastResponseObj = resp;
            lastResponseId = resp?.id || payloadObj?.response_id || lastResponseId;
            lastSeenModel = resp?.model || lastSeenModel;
            logger.info(`[STREAM] Response completed: thread=${threadId} plan=${userPlan} model=${lastSeenModel || model} response=${lastResponseId || 'unknown'}`);
            break;
          }
          case 'response.failed':
          case 'error': {
            const msg =
              payloadObj?.error?.message ||
              payloadObj?.message ||
              'OpenAI stream error';
            if (!hadTokens) {
              send('error', { message: msg });
            } else {
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
      try {
        // Fallback: if no deltas were captured, extract final output text from the completed response object.
        if ((!accText || !accText.trim()) && lastResponseObj) {
          accText = extractOutputTextFromResponse(lastResponseObj);
        }

        const cleaned = (accText || '').replace(/【.*?】/g, '');
        const sanitized = sanitizeHtml(cleaned, {
          allowedTags: ['a', 'b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
          allowedAttributes: { 'span': ['class'], 'a': ['href', 'title', 'target', 'rel'] },
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
        conversation.lastResponseId = lastResponseId || conversation.lastResponseId || null;
        conversation.lastAssistantId = null;
        conversation.lastModel = (lastSeenModel || model || conversation.lastModel || null);
        await conversation.save();
        const savedAssistant = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

        send('final', { html: finalHtml, messageId: savedAssistant?._id || null, responseId: conversation.lastResponseId || null, model: conversation.lastModel || null });
      } catch (e) {
        send('error', { message: e.message || 'Failed to finalize message' });
      } finally {
        try { inFlightByThreadId.delete(threadId); } catch { }
        send('done', { ok: true });
        res.end();
      }
    });

    stream.on('error', (err) => {
      try { inFlightByThreadId.delete(threadId); } catch { }
      send('error', { message: err?.message || 'OpenAI stream connection error' });
      try { res.end(); } catch { }
    });

  } catch (error) {
    // If streaming fails early, report and close
    logger.error('[STREAM] Hiba az üzenetküldés során:', {
      message: error.message,
      stack: error.stack,
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
        logger.error(`[STREAM] 400 detailed body: ${JSON.stringify(error.response.data).slice(0, 2048)}`);
      } catch (_) {
        logger.error(`[STREAM] 400 detailed text: ${String(error?.response?.data || error.message)}`);
      }
    }
    try {
      send('error', { message: error.message || 'Váratlan hiba történt.' });
      send('done', { ok: false });
    } finally {
      try {
        const threadId = String(req?.body?.threadId || '').trim();
        if (threadId) inFlightByThreadId.delete(threadId);
      } catch { }
      return res.end();
    }
  }

}

module.exports = { handleSendMessageStream };
