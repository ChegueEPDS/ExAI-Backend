const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const logger = require('../config/logger');
const InjectionRule = require('../models/injectionRule');
const { resolveUserAndTenant, resolveAssistantForTenant, ensureConversationOwnership } = require('../services/chatAccessService');
const { resolveUserPlan } = require('../services/chatContextService');
const { categorizeMessageUsingAI } = require('../helpers/categorizeMessage');
const { validationResult } = require('express-validator');
const { getStyleInstructions, buildTabularHint, buildRollingSummary, getAssistantInfoCached } = require('../services/chatPromptService');
const { extractOutputTextFromResponse } = require('../helpers/openaiResponses');
const { createResponse } = require('../helpers/openaiResponses');

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
      const userId = req.userId;

      if (!userId) {
        logger.error('Hiányzó userId a kérésből.');
        return res.status(400).json({ error: 'Bejelentkezett felhasználó azonosítója hiányzik.' });
      }

      logger.info(`Üzenet fogadva a szálhoz: ${threadId}, Üzenet: ${message}`);

      let tenantId;
      let assistantId;
      let tenantKey;
      try {
        const resolved = await resolveUserAndTenant(req);
        tenantId = resolved.tenantId;
        const assistantCtx = await resolveAssistantForTenant(tenantId, 'CHAT');
        assistantId = assistantCtx.assistantId;
        tenantKey = assistantCtx.tenantKey;
      } catch (e) {
        return res.status(e?.status || 500).json({ error: e?.message || 'Váratlan hiba történt.' });
      }

      // Determine user plan (best effort) and log context
      const userPlan = await resolveUserPlan(req, tenantId, logger);
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

      const assistantInfo = await getAssistantInfoCached(assistantId);
      const assistantPrompt = String(assistantInfo?.instructions || '');
      const baseInstructions = `${assistantPrompt}\n\n${styleForPlain}${convBlock}`.trim();

      let finalInstructions = baseInstructions;
      if (tabularHint) finalInstructions = `${finalInstructions}\n\n${tabularHint}`;
      if (applicableInjection) {
        finalInstructions =
          `${finalInstructions}\n\n` +
          'Always put the following sentence at the end of the explanation part as a <strong>Note:</strong>, ' +
          'exactly as written, in a separate paragraph between <em> tags: :\n\n' +
          `"${applicableInjection}"`;
      }

      const model = String(assistantInfo?.model || conversation?.lastModel || 'gpt-5-mini').trim() || 'gpt-5-mini';
      const payload = {
        model,
        store: true,
        instructions: finalInstructions,
        input: [{ role: 'user', content: message }],
        ...(conversation?.lastResponseId ? { previous_response_id: String(conversation.lastResponseId) } : {}),
        ...(vectorStoreId && typeof vectorStoreId === 'string' && vectorStoreId.trim()
          ? { tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId.trim()] }] }
          : {}),
      };

      const respObj = await createResponse({
        model: payload.model,
        instructions: payload.instructions,
        input: payload.input,
        previousResponseId: payload.previous_response_id || null,
        tools: payload.tools || null,
        store: true,
        temperature: 0,
        maxOutputTokens: 2500,
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
      conversation.lastAssistantId = assistantId || conversation.lastAssistantId || null;
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
        } catch (_) { }
        logger.error(`[CHAT] 400 detailed text: ${String(error?.response?.data || error.message)}`);
      }
      res.status(500).json({ error: 'Váratlan hiba történt.' });
    }
  
}

module.exports = { handleSendMessage };
