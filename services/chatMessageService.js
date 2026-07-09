const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const crypto = require('crypto');
const logger = require('../config/logger');
const InjectionRule = require('../models/injectionRule');
const { resolveUserAndTenant, resolveAssistantForTenant, ensureConversationOwnership } = require('../services/chatAccessService');
const { resolveUserPlan } = require('../services/chatContextService');
const { categorizeMessageUsingAI } = require('../helpers/categorizeMessage');
const { validationResult } = require('express-validator');
const { getStyleInstructions, buildTabularHint, buildRollingSummary, getTenantAiProfileCached } = require('../services/chatPromptService');
const { extractOutputTextFromResponse } = require('../helpers/openaiResponses');
const { createResponse } = require('../helpers/openaiResponses');
const tenantSettingsStore = require('../services/tenantSettingsStore');

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
  "építési hely meghatározás": ["KESZ_7_MELL-7.png"],
  "utcai párkánymagasság": ["KESZ_7_MELL-15.png"],
  "magassági idom": ["KESZ_7_MELL-18.png"],
  "Az építési övezetek magassági szabályozása": ["KESZ_4_MELL_MAGASSAG.png"],
  "XIII kerület magassági szabályozás": ["KESZ_4_MELL_MAGASSAG.png"],
  "épületmagasság": ["KESZ_4_MELL_MAGASSAG.png"],
};

async function handleSendMessage(req, res) {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.error('Validációs hiba:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { message, threadId, category, vectorStoreId } = req.body;
      const fileIds = normalizeFileIds(req.body?.fileIds);
      const userId = req.userId;

      if (!userId) {
        logger.error('Hiányzó userId a kérésből.');
        return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
      }

      logger.info(`Üzenet fogadva a szálhoz: ${threadId}, Üzenet: ${message}`);

      let tenantId;
      let tenantKey;
      try {
        const resolved = await resolveUserAndTenant(req);
        tenantId = resolved.tenantId;
        const assistantCtx = await resolveAssistantForTenant(tenantId, 'CHAT');
        tenantKey = assistantCtx.tenantKey;
      } catch (e) {
        return res.status(e?.status || 500).json({ error: e?.message || 'Váratlan hiba történt.' });
      }

      // Determine user plan (best effort) and log context
      const userPlan = await resolveUserPlan(req, tenantId, logger);
      logger.info(`[CHAT] Context: thread=${threadId} tenant=${tenantKey} plan=${userPlan}`);

      let applicableInjection = null;
      if (tenantKey === 'wolff') {
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

      let conversation;
      try {
        conversation = await ensureConversationOwnership({ threadId, userId, tenantId });
      } catch (e) {
        logger.error('Beszélgetés nem található a megadott szálhoz:', threadId);
        return res.status(e?.status || 404).json({ error: e?.message || 'A megadott szál nem található.' });
      }

      // ---- Prepare Responses payload (store:true + previous_response_id chaining) ----
      const rolling = await buildRollingSummary(conversation).catch(() => '');
      const convBlock = rolling ? `\n\nCONVERSATION SUMMARY (for context—do not use as evidence):\n${rolling}\n` : '';
      const styleForPlain = getStyleInstructions('plain');
      const tabularHint = buildTabularHint(message);

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
        model: payload.model,
        previousResponseId: payload.previous_response_id ? String(payload.previous_response_id) : null,
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

      const respObj = await createResponse({
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
        timeoutMs: 60_000,
      });
      let assistantContent = extractOutputTextFromResponse(respObj);
      const responseId = respObj?.id ? String(respObj.id) : null;
      const usedModel = respObj?.model ? String(respObj.model) : model;
      logger.info(`[CHAT] Response completed: thread=${threadId} plan=${userPlan} model=${usedModel} response=${responseId || 'unknown'}`);

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
      conversation.lastResponseId = responseId || conversation.lastResponseId || null;
      conversation.lastAssistantId = null;
      conversation.lastModel = usedModel || conversation.lastModel || null;

      await conversation.save();

      const lastAssistantMessage = conversation.messages.slice().reverse().find(m => m.role === 'assistant');


      res.json({
        html: assistantContentHtml,
        images: imageUrls.length > 0 ? imageUrls : [],
        messageId: lastAssistantMessage?._id,  // ✅ új elem _id-ját visszaküldjük
        responseId: conversation.lastResponseId || null,
        model: conversation.lastModel || null,
      });

    } catch (error) {
      logger.error('Hiba az üzenetküldés során:', {
        message: error.message,
        stack: error.stack,
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
          logger.error(`[CHAT] 400 detailed body: ${JSON.stringify(error.response.data).slice(0, 2048)}`);
        } catch (_) { }
        logger.error(`[CHAT] 400 detailed text: ${String(error?.response?.data || error.message)}`);
      }
      res.status(500).json({ error: 'Váratlan hiba történt.' });
    }
  
}

module.exports = { handleSendMessage };
