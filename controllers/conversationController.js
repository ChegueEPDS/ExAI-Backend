// === ChatGPT-like formatting instructions (Markdown-first) ===
function getStyleInstructions(mode = 'plain') {
  const base = [
    'You are a helpful, precise assistant in the style of ChatGPT.',
    'Use clear, natural language. Prefer **well‑structured Markdown** when it improves readability (headings, short lists, and tables).',
    'Do **not** force a fixed section template; create sections only if they help the reader.',
    'Leverage the ongoing conversation for context and be consistent with prior answers.',
    'Be concise by default; expand with details only when useful.',
    'If you rely on uploaded files or source documents, mention filenames or section titles when that helps attribution.',
    'Avoid speculation: if something is not in the provided context, say so briefly.',
    'If crucial details are missing, ask one concise clarifying question before proceeding.',
    'Tone: professional, friendly, and direct. Avoid filler.',
    'Always respond in the same language as the user\'s latest message. Detect the language automatically. If the message is multilingual or unclear, reply in the language most used by the user and briefly ask for clarification in that language. Do not switch languages unless the user explicitly asks.',
    'When quoting from files, keep the original quote language, but write your commentary in the user\'s language.'
  ].join(' ');

  if (mode === 'sandbox') {
    return (
      base +
      ' You are analyzing a fresh set of uploaded files in isolation. Use only these files and the current conversation turn for evidence. ' +
      'Cite filenames inline when quoting or extracting data. Do not enumerate all files unless the user asks. Produce a standalone answer tailored to the question.'
    );
  }
  if (mode === 'hybrid') {
    return (
      base +
      ' Continue the discussion using both prior conversation context and any files associated with the thread. ' +
      'Keep terminology aligned with earlier replies. Do not enumerate all files unless requested; cite filenames only when relevant.'
    );
  }
  return base;
}

function detectReportOrTableIntent(userMsg = '') {
  const m = String(userMsg || '').toLowerCase();
  const kws = [
    // generic analysis / table cues
    'kimutatás', 'kimutatas', 'elemzés', 'elemzes', 'összehasonlítás', 'osszehasonlitas',
    'táblázat', 'tablazat', 'riport', 'report', 'summary', 'összefoglaló', 'osszefoglalo',
    'kpi', 'mutató', 'mutato', 'statisztika', 'metrics', 'table', 'matrix', 'lista', 'ranking',
    'top', 'trend', 'pivot', 'dashboard',
    // compliance / standards cues
    'compliance', 'non-compliance', 'noncompliance', 'conformance', 'conformity',
    'standard', 'standards', 'clause', 'clauses', 'requirement', 'requirements',
    'gap', 'gap analysis', 'audit', 'checklist',
    // Hungarian compliance cues
    'megfelelés', 'megfeleles', 'megfelel', 'nem megfelelés', 'nem megfeleles',
    'szabvány', 'szabvany', 'követelmény', 'kovetelmeny', 'eltérés', 'elteres',
    'hiányosság', 'hianyossag', 'eltéréslista', 'osszevetes'
  ];
  return kws.some(k => m.includes(k));
}

function detectComplianceIntent(userMsg = '') {
  const m = String(userMsg || '').toLowerCase();
  const kws = [
    'compliance', 'non-compliance', 'noncompliance', 'conformance', 'conformity',
    'standard', 'standards', 'clause', 'clauses', 'requirement', 'requirements',
    'gap', 'gap analysis', 'audit', 'checklist',
    // Hungarian
    'megfelelés', 'megfeleles', 'megfelel', 'nem megfelelés', 'nem megfeleles',
    'szabvány', 'szabvany', 'követelmény', 'kovetelmeny', 'eltérés', 'elteres',
    'hiányosság', 'hianyossag', 'eltéréslista'
  ];
  return kws.some(k => m.includes(k));
}

function buildTabularHint(userMsg = '') {
  const lines = [
    'Decide whether a compact **Markdown table** would improve clarity for the current request. If so, include one.',
    '- Keep ≤ 10 columns and ≤ 30 rows; if larger, show an aggregated/top view and state the filter.',
    '- Use short column headers and include units; avoid empty columns and do not fabricate data.',
    '- After the table, add 1–2 bullet takeaways.',
    'If the request involves standards, clauses, requirements, conformity, audits, or compliance (in any language), include a table titled "Compliance summary" with columns like: Item/Subject, Requirement/Clause, Evidence (short quote with filename), Status (Compliant/Partial/Non‑compliant/Not found), Notes/Gap. Place this table immediately after a short direct answer.'
  ];
  return lines.join(' ');
}

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

    // ---- Prepare run payload, always add ChatGPT-like style instructions; append injection if present ----
    // Build a concise rolling summary of the conversation so far (tone/continuity aid; not evidence)
    const rolling = await buildRollingSummary(conversation).catch(() => '');
    const convBlock = rolling ? `\n\nCONVERSATION SUMMARY (for context—do not use as evidence):\n${rolling}\n` : '';

    const payload = { assistant_id: assistantId, stream: true };
    const styleForPlain = getStyleInstructions('plain');
    const tabularHint = buildTabularHint(message);

    if (applicableInjection) {
      const assistantData = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' }
      });
      const assistantPrompt = assistantData.data.instructions || '';
      const finalInstructions = `${styleForPlain}${convBlock}\n${assistantPrompt}\n\n${tabularHint ? tabularHint + '\n\n' : ''}Always put the following sentence at the end of the explanation part as a <strong>Note:</strong>, exactly as written, in a separate paragraph between <em> tags: :\n\n"${applicableInjection}"`;      logger.info('[STREAM] 📋 Final instructions before sending:', finalInstructions);
      payload.instructions = finalInstructions;
    } else {
      // No injection rule matched → still enforce ChatGPT-like structure
      payload.instructions = tabularHint ? `${styleForPlain}${convBlock}\n\n${tabularHint}` : `${styleForPlain}${convBlock}`;    }

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
        try { payload = dataStr ? JSON.parse(dataStr) : null; } catch { }

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
            } catch { }
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
      try { await delay(800); } catch { }
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
            try { await delay(500); } catch { }
          }
          if (fetchedText) {
            accText = fetchedText;
          }
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
      try { res.end(); } catch { }
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
// ===== Hybrid/Sandbox: Chat with file focus → Assistants v2 (SSE) =====
// POST is expected to be multipart/form-data (files[]) or JSON with fileIds[].
// Body:
//   - mode: "hybrid" | "sandbox"  (default: "hybrid")
//   - message: string (required)
//   - threadId: string (required)
//   - fileIds?: string[] (optional; already uploaded OpenAI file IDs)
// Uploads come via multer memory storage as req.files (buffer).
exports.chatWithFilesStream = async (req, res) => {
  const send = sseInit(req, res);

  // Small util: fetch vector store id bound to an assistant
  async function getAssistantVectorStoreId(assistantId) {
    const resp = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2'
      }
    });
    const vs = resp.data?.tool_resources?.file_search?.vector_store_ids || [];
    return vs.length ? vs[0] : null;
  }

  try {
    const { mode: rawMode, message, threadId } = req.body || {};
    const mode = (rawMode === 'sandbox' ? 'sandbox' : 'hybrid');
    const userId = req.userId;

    // fileIds may arrive as JSON-string or array (depending on client)
    let fileIdsParam = [];
    if (Array.isArray(req.body?.fileIds)) fileIdsParam = req.body.fileIds;
    else if (typeof req.body?.fileIds === 'string') {
      try { fileIdsParam = JSON.parse(req.body.fileIds); } catch { fileIdsParam = []; }
    }

    if (!userId) {
      send('error', { message: 'Hiányzó vagy érvénytelen JWT.' });
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

    // ---- Resolve user, tenant, assistant (like sendMessageStream) ----
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
    const baseAssistantId = assistants.byTenant?.[tenantKey] || assistants['default'];

    // ---- Load conversation & ownership ----
    const conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) {
      send('error', { message: 'A megadott szál nem található.' });
      send('done', { ok: false });
      return res.end();
    }

    // Rolling summary to help the model stay consistent with the dialogue (not evidence)
    const rolling = await buildRollingSummary(conversation).catch(() => '');

    // ---- Ensure no active run on this thread ----
    const runsResponse = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' },
    });
    const activeRun = runsResponse.data.data.find(r => ['queued', 'in_progress', 'requires_action', 'cancelling'].includes(r.status));
    if (activeRun) {
      send('error', { message: `Már fut egy aktív feldolgozás (${activeRun.status}).`, activeRunId: activeRun.id, status: activeRun.status });
      send('done', { ok: false });
      return res.end();
    }

    // ---- 1) Collect/Transform/Upload files → fileIds[]
    const uploads = req.files || [];
    const fileIds = [...fileIdsParam];

    for (const f of uploads) {
      let uploadBuffer = f.buffer;
      let uploadName = f.originalname;
      let uploadMime = f.mimetype || 'application/octet-stream';

      const lowerName = (f.originalname || '').toLowerCase();
      const isExcel =
        lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx') ||
        (uploadMime.includes('excel') || uploadMime.includes('spreadsheetml'));

      if (isExcel) {
        let converted = false;
        try {
          // 1) Excel → CSV (összes sheet)
          const wb = xlsx.read(f.buffer, { type: 'buffer' });
          const parts = [];
          wb.SheetNames.forEach(sheet => {
            const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false });
            parts.push(`-- SHEET: ${sheet} --\n${csv}`);
          });
          const csvText = parts.join('\n\n');

          // 2) CSV → TXT (elsődleges út)
          const txtText = String(csvText || '');
          const txtBuf = Buffer.from(txtText, 'utf8');
          if (txtBuf && txtBuf.length > 0) {
            uploadBuffer = txtBuf;
            uploadName = f.originalname.replace(/\.(xls|xlsx)$/i, '') + '.txt';
            uploadMime = 'text/plain';
            converted = true;
            send('progress', { stage: 'file.transform', file: f.originalname, as: uploadName, info: 'excel→csv→txt' });
          }

          // 3) Ha a TXT valamiért nem jött össze (ritka), próbáljunk PDF-et
          if (!converted) {
            const pdfBuf = await tryMakePdfFromText(csvText, `Converted from ${f.originalname}`);
            if (pdfBuf) {
              uploadBuffer = pdfBuf;
              uploadName = f.originalname.replace(/\.(xls|xlsx)$/i, '') + '.pdf';
              uploadMime = 'application/pdf';
              converted = true;
              send('progress', { stage: 'file.transform', file: f.originalname, as: uploadName, info: 'excel→pdf (csv/txt failed)' });
            }
          }

          // Ha eddig sem sikerült, essünk át a catch-be (skip)
          if (!converted) {
            throw new Error('TXT/PDF conversion not achieved after CSV');
          }

        } catch (e) {
          logger.warn('[CHAT_WITH_FILES] Excel→(csv/txt) conversion failed, trying PDF fallback. Details:', e?.message);

          // Utolsó próbálkozás: közvetlen PDF a sheet-ek nyers sorainak összeillesztésével
          try {
            const wb2 = xlsx.read(f.buffer, { type: 'buffer' });
            const txtParts = [];
            wb2.SheetNames.forEach(sheet => {
              const rows = xlsx.utils.sheet_to_json(wb2.Sheets[sheet], { header: 1, blankrows: false });
              const lines = rows.map(r => (Array.isArray(r) ? r.join('\t') : String(r))).join('\n');
              txtParts.push(`-- SHEET: ${sheet} --\n${lines}`);
            });
            const fallbackText = txtParts.join('\n\n');
            const pdfBuf = await tryMakePdfFromText(fallbackText, `Converted from ${f.originalname}`);
            if (pdfBuf) {
              uploadBuffer = pdfBuf;
              uploadName = f.originalname.replace(/\.(xls|xlsx)$/i, '') + '.pdf';
              uploadMime = 'application/pdf';
              send('progress', { stage: 'file.transform', file: f.originalname, as: uploadName, info: 'excel→pdf (direct fallback)' });
            } else {
              // PDF sem sikerült → SKIP
              send('progress', { stage: 'file.skipped', file: f.originalname, reason: 'excel conversion and pdf fallback failed' });
              continue; // ugorjuk ezt a fájlt
            }
          } catch (e2) {
            // Workbook sem olvasható → SKIP
            send('progress', { stage: 'file.skipped', file: f.originalname, reason: 'excel parse failed, pdf fallback unavailable' });
            continue; // ugorjuk ezt a fájlt
          }
        }
      }

      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append('file', uploadBuffer, { filename: uploadName, contentType: uploadMime });

      const up = await axios.post('https://api.openai.com/v1/files', form, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
        maxBodyLength: Infinity
      });
      fileIds.push(up.data.id);
      send('progress', { stage: 'file.uploaded', file: uploadName, original: f.originalname, fileId: up.data.id });
    }

    // ---- 2) HYBRID vs SANDBOX resource preparation ----
    let assistantIdToUse = baseAssistantId;
    let vectorStoreIdToUse = null;

    if (mode === 'sandbox') {
      // 2.a) new vector store
      const vs = await axios.post('https://api.openai.com/v1/vector_stores', { name: `sandbox-${threadId}-${Date.now()}` }, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2', 'Content-Type': 'application/json' }
      });
      vectorStoreIdToUse = vs.data.id;

      // 2.b) attach files to new store
      for (const fid of fileIds) {
        await axios.post(
          `https://api.openai.com/v1/vector_stores/${vectorStoreIdToUse}/files`,
          { file_id: fid },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2', 'Content-Type': 'application/json' } }
        );
      }

      // 2.c) create a dedicated assistant bound to this store (gpt-4o-mini)
      const a = await axios.post('https://api.openai.com/v1/assistants', {
        model: 'gpt-4o-mini',
        name: `Sandbox Assistant for ${threadId}`,
        tools: [{ type: 'file_search' }],
        tool_resources: { file_search: { vector_store_ids: [vectorStoreIdToUse] } }
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2', 'Content-Type': 'application/json' } });
      assistantIdToUse = a.data.id;

      // Persist minimal context so later turns can continue
      // Ensure job object has required fields (JobSchema requires `type`)
      if (!conversation.job) conversation.job = {};
      if (!conversation.job.type) {
        conversation.job.type = 'chat_with_files';
        conversation.job.status = conversation.job.status || 'succeeded';
        conversation.job.stage = conversation.job.stage || 'context';
        conversation.job.progress = conversation.job.progress || {};
        conversation.job.error = conversation.job.error || null;
        conversation.job.startedAt = conversation.job.startedAt || new Date();
        conversation.job.finishedAt = conversation.job.finishedAt || new Date();
      }
      conversation.job.meta = conversation.job.meta || {};
      conversation.job.meta.sandboxContext = {
        mode: 'sandbox',
        assistantId: assistantIdToUse,
        vectorStoreId: vectorStoreIdToUse,
        fileIds
      };

      // Also persist top-level context for easy continuation
      conversation.mode = 'sandbox';
      conversation.assistantId = assistantIdToUse;
      conversation.vectorStoreId = vectorStoreIdToUse;
      conversation.fileIds = fileIds;
      await conversation.save();
    } else {
      // HYBRID: use existing assistant's vector store and add files there
      vectorStoreIdToUse = await getAssistantVectorStoreId(baseAssistantId);
      if (vectorStoreIdToUse && fileIds.length) {
        for (const fid of fileIds) {
          try {
            await axios.post(
              `https://api.openai.com/v1/vector_stores/${vectorStoreIdToUse}/files`,
              { file_id: fid },
              { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2', 'Content-Type': 'application/json' } }
            );
          } catch (e) {
            // ignore 409 already-attached errors
          }
        }
      }
      // Persist last-used hybrid focus for continuity (under job.meta)
      if (!conversation.job) conversation.job = {};
      if (!conversation.job.type) {
        conversation.job.type = 'chat_with_files';
        conversation.job.status = conversation.job.status || 'succeeded';
        conversation.job.stage = conversation.job.stage || 'context';
        conversation.job.progress = conversation.job.progress || {};
        conversation.job.error = conversation.job.error || null;
        conversation.job.startedAt = conversation.job.startedAt || new Date();
        conversation.job.finishedAt = conversation.job.finishedAt || new Date();
      }
      conversation.job.meta = conversation.job.meta || {};
      conversation.job.meta.hybridContext = {
        mode: 'hybrid',
        assistantId: baseAssistantId,
        vectorStoreId: vectorStoreIdToUse,
        fileIds
      };

      // Also persist top-level context for easy continuation
      conversation.mode = 'hybrid';
      conversation.assistantId = baseAssistantId;
      if (vectorStoreIdToUse) conversation.vectorStoreId = vectorStoreIdToUse;
      conversation.fileIds = fileIds;
      await conversation.save();
    }

    // ---- 3) Post the user message (ALWAYS attach message-level files to prioritize them) ----
    const useMessageAttachments = true; // keep parity with the earlier fixed version: always attach to the message
    let messagePayload = { role: 'user', content: message };

    if (useMessageAttachments && Array.isArray(fileIds) && fileIds.length) {
      messagePayload.attachments = fileIds.map(fid => ({ file_id: fid, tools: [{ type: 'file_search' }] }));
    }

    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      messagePayload,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' } }
    );

    // ---- Build ChatGPT-like instructions with explicit file inventory (attached + DB fileIds + optional store) ----
    // 1) Freshly attached files (multer)
    let attachedNames = [];
    try {
      if (Array.isArray(req.files)) {
        attachedNames = req.files.map(f => f.originalname).filter(Boolean);
      }
    } catch { }

    // 2) Files already associated in DB (conversation.fileIds → resolve to filenames)
    let dbNames = [];
    try {
      const dbFileIds = Array.isArray(conversation.fileIds) ? conversation.fileIds.filter(Boolean) : [];
      if (dbFileIds.length) {
        const batchSize = 20;
        for (let i = 0; i < dbFileIds.length; i += batchSize) {
          const batch = dbFileIds.slice(i, i + batchSize);
          const reqs = batch.map(fid => axios.get(`https://api.openai.com/v1/files/${fid}`, {
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
          }));
          const results = await Promise.allSettled(reqs);
          results.forEach(r => {
            if (r.status === 'fulfilled') {
              const nm = r.value?.data?.filename || r.value?.data?.name || null;
              if (nm) dbNames.push(nm);
            }
          });
        }
      }
    } catch (e) {
      logger.warn('[FILES INVENTORY] Failed to resolve DB fileIds to names:', e?.response?.data || e?.message);
    }

    // 3) Optional: vector store file names (only if dbNames is empty and a store exists)
    let storeNames = [];
    try {
      if (!dbNames.length && vectorStoreIdToUse) {
        const list1 = await axios.get(`https://api.openai.com/v1/vector_stores/${vectorStoreIdToUse}/files?limit=200`, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' }
        });
        const fileIdsInStore = (list1.data?.data || []).map(x => x.id);
        const batchSize = 20;
        for (let i = 0; i < fileIdsInStore.length; i += batchSize) {
          const batch = fileIdsInStore.slice(i, i + batchSize);
          const reqs = batch.map(fid => axios.get(`https://api.openai.com/v1/files/${fid}`, {
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
          }));
          const results = await Promise.allSettled(reqs);
          results.forEach(r => {
            if (r.status === 'fulfilled') {
              const nm = r.value?.data?.filename || r.value?.data?.name || null;
              if (nm) storeNames.push(nm);
            }
          });
        }
      }
    } catch (e) {
      logger.warn('[FILES INVENTORY] Failed to enumerate vector store files:', e?.response?.data || e?.message);
    }

    // 4) Compose final inventory and instructions
    const inventoryNames = Array.from(new Set([...attachedNames, ...dbNames, ...storeNames]));
    const inventoryBlock = inventoryNames.length
      ? 'FILES IN SCOPE (filenames):\n' + inventoryNames.map(n => `- ${n}`).join('\n')
      : 'FILES IN SCOPE: (none reported)';

    const styleForMode = getStyleInstructions(mode);
    const tabularHint = buildTabularHint(message);
    const enforcedIntroParts = [
      styleForMode,
      (rolling ? `\nConversation summary (for context—do not use as evidence):\n${rolling}\n` : ''),
      '\nAt the very top of your answer, output a short bulleted list titled **Files in scope** with the exact filenames below (one per bullet).',
      inventoryBlock,
      '\nThen proceed to answer. First, search the files attached to this message (and any files already associated with the thread). Treat these as the PRIMARY source of truth. Only if they clearly do not contain the answer, use prior conversation context or general knowledge.',
      'When you quote or rely on a document, mention its filename inline.',
      'Structure your answer dynamically. If a brief direct answer is sufficient, give it first, then optional details.',
      'Use Markdown selectively (short headings/lists/tables) only when they improve clarity. Avoid boilerplate sections.',
      'If calculations or data extraction are required, present results clearly and add a short “Method” note only when helpful.',
      'If information is missing, say so and suggest one next step at most.'
    ];
    if (tabularHint) enforcedIntroParts.push(tabularHint);
    const enforcedIntro = enforcedIntroParts.join('\n');

    // ---- 4) Start the streamed run (same streaming infra as sendMessageStream) ----
    const runPayload = { assistant_id: assistantIdToUse, stream: true, instructions: enforcedIntro };
    if (vectorStoreIdToUse) {
      runPayload.tool_resources = { file_search: { vector_store_ids: [vectorStoreIdToUse] } };
    }

    const openaiResp = await axios({
      method: 'post',
      url: `https://api.openai.com/v1/threads/${threadId}/runs`,
      data: runPayload,
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

    let accText = '';
    let lastAssistantMessageId = null;
    let buffer = '';
    let hadTokens = false;

    const extractDeltaPieces = (payloadObj) => {
      const pieces = [];
      const contentArr = payloadObj?.delta?.content;
      if (Array.isArray(contentArr)) {
        for (const part of contentArr) {
          if (part?.type === 'output_text.delta') {
            const txt = (typeof part?.text === 'string' ? part.text : '') || (typeof part?.delta?.text === 'string' ? part.delta.text : '');
            if (txt) pieces.push(txt);
          }
          if (part?.delta?.type === 'text_delta' && typeof part?.delta?.text === 'string') pieces.push(part.delta.text);
          if (part?.type === 'text' && typeof part?.text?.value === 'string') pieces.push(part.text.value);
        }
      }
      if (!pieces.length && payloadObj?.delta) {
        const d = payloadObj.delta;
        if (d?.type === 'output_text.delta' && typeof d?.text === 'string') pieces.push(d.text);
        else if (d?.type === 'text_delta' && typeof d?.text === 'string') pieces.push(d.text);
        else if (typeof d?.text?.value === 'string') pieces.push(d.text.value);
      }
      const deltasArr = payloadObj?.deltas;
      if (!pieces.length && Array.isArray(deltasArr)) {
        for (const d of deltasArr) {
          if (d?.type === 'output_text.delta' && typeof d?.text === 'string') pieces.push(d.text);
          if (d?.type === 'text_delta' && typeof d?.text === 'string') pieces.push(d.text);
        }
      }
      if (!pieces.length && typeof payloadObj?.text === 'string') pieces.push(payloadObj.text);
      if (!pieces.length && typeof payloadObj?.message?.content?.[0]?.text?.value === 'string') {
        pieces.push(payloadObj.message.content[0].text.value);
      }
      return pieces;
    };

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
        try { payload = dataStr ? JSON.parse(dataStr) : null; } catch { }

        switch (eventName) {
          case 'thread.message.delta':
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
            } catch { }
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
            break;
          }
          case 'error': {
            const msg = payload?.message || 'OpenAI stream error';
            if (!hadTokens) send('error', { message: msg });
            break;
          }
          default:
            break;
        }
      }
    };

    const stream = openaiResp.data;
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
      }
    });

    stream.on('end', async () => {
      try { await delay(600); } catch { }
      try {
        if (!accText || !accText.trim()) {
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
                if (item?.type === 'text' && typeof item?.text?.value === 'string') fallbackTxt += item.text.value;
              }
            }
            if (!fallbackTxt && typeof assistantMsg?.content === 'string') fallbackTxt = assistantMsg.content;
            if (fallbackTxt) accText = fallbackTxt;
          }
        }

        const cleaned = (accText || '').replace(/【.*?】/g, '');
	    // Render markdown -> HTML, then sanitize the generated HTML.
	    // This keeps formatting consistent (lists, tables, headings) and prevents raw-HTML injection.
	    let renderedHtml = '';
	    try {
	      renderedHtml = (typeof marked?.parse === 'function')
	        ? marked.parse(cleaned, { gfm: true })
	        : marked(cleaned);
	    } catch {
	      renderedHtml = `<pre>${sanitizeHtml(cleaned)}</pre>`;
	    }
	
	    const finalHtml = sanitizeHtml(renderedHtml, {
	      allowedTags: ['a', 'b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
	      allowedAttributes: { 'span': ['class'], 'a': ['href', 'title', 'target', 'rel'] },
	      transformTags: {
	        'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true)
	      },
	      disallowedTagsMode: 'discard'
	    });

        conversation.messages.push({ role: 'user', content: message, meta: { kind: 'chat-with-files', mode, fileIds } });
        conversation.messages.push({ role: 'assistant', content: finalHtml, images: [] });
        await conversation.save();
        const savedAssistant = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

        send('final', { html: finalHtml, messageId: savedAssistant?._id || lastAssistantMessageId || null });

        // --- finalize job state for chat_with_files so UI won't show Queued after reload ---
        try {
          if (!conversation.job) conversation.job = {};
          conversation.job.type = 'chat_with_files';
          conversation.job.status = 'succeeded';
          conversation.job.stage = 'done';
          conversation.job.finishedAt = new Date();
          conversation.job.updatedAt = new Date();
          conversation.hasBackgroundJob = false;
          await conversation.save();
        } catch (e2) {
          logger.warn('[CHAT_WITH_FILES] Failed to finalize job state:', e2?.message);
        }
      } catch (e) {
        send('error', { message: e.message || 'Failed to finalize message' });
      } finally {
        send('done', { ok: true });
        try { res.end(); } catch { }
      }
    });

    stream.on('error', (err) => {
      send('error', { message: err?.message || 'OpenAI stream connection error' });
      try { res.end(); } catch { }
    });

  } catch (error) {
    logger.error('[CHAT_WITH_FILES] Hiba:', {
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

const Conversation = require('../models/conversation');
const RagChunk = require('../models/ragChunk');
const InjectionRule = require('../models/injectionRule');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
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
const OpenAI = require('openai');

const FormData = require('form-data');

// --- Optional PDF creator (fallbacks to null if 'pdfkit' is not installed) ---
async function tryMakePdfFromText(text, title = 'Converted from spreadsheet') {
  try {
    const PDFDocument = require('pdfkit');
    return await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', (b) => chunks.push(b));
      doc.on('error', (err) => reject(err));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      if (title) {
        doc.fontSize(14).text(String(title), { underline: true });
        doc.moveDown(0.5);
      }
      const safeText = String(text || '').replace(/\u0000/g, '');
      doc.fontSize(10).text(safeText, { lineGap: 2 });
      doc.end();
    });
  } catch (e) {
    logger.warn('[CHAT_WITH_FILES] pdfkit not available; cannot create PDF. Details:', e?.message);
    return null;
  }
}

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
  conversation.hasBackgroundJob = ['queued', 'running'].includes(job.status);
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

function cosineSimilarity(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function tokenTrim(text, maxTokens) {
  const ids = encoder.encode(String(text || ''));
  return encoder.decode(ids.slice(0, Math.max(0, maxTokens)));
}

function sanitizeEmbeddingInput(s) {
  // Embeddings input must be a string; remove NUL + other control chars (keep \n \r \t).
  return String(s || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .trim();
}

function detectIntent(userMsg = '') {
  const m = String(userMsg || '').toLowerCase();
  const has = (...kws) => kws.some(k => m.includes(k));

  const nb = has('notified body', 'tanúsító', 'tanusito', 'nb', 'megfelelőség', 'megfelelos', 'compliance', 'audit');
  const risk = has('kockázat', 'kockazat', 'risk', 'hazard', 'veszély', 'veszely', 'fmea');
  const compare = has('összehasonl', 'osszehasonl', 'compare', 'comparison', 'különbség', 'kulonbseg', 'diff', 'versus', 'vs ');
  const changed = has('mi változott', 'mi valtozott', 'változás', 'valtozas', 'change log', 'changelog', 'delta', 'változott', 'valtozott');
  const standards = has('szabvány', 'szabvany', 'standard', 'standards', '60079', 'clause', 'követelmény', 'kovetelmeny', 'requirement');
  const exec = has('vezetői', 'vezetoi', 'executive', 'vezetői összefoglaló', 'vezetoi osszefoglalo', 'összefoglaló', 'osszefoglalo', 'tl;dr', 'tldr');
  const howto = has('hogyan', 'hogy volt', 'hogy volt?', 'how', 'how was', 'módszer', 'modszer', 'method', 'folyamat', 'process');

  if (nb || risk) return 'nb_audit';
  if (changed) return 'what_changed';
  if (compare) return 'comparison';
  if (standards) return 'standards';
  if (exec) return 'exec_summary';
  if (howto) return 'howto';
  return 'general';
}

function detectLanguage(userMsg = '') {
  const raw = String(userMsg || '');
  const s = raw.toLowerCase();
  // Very lightweight heuristic: Hungarian has frequent accented vowels and function words.
  const hasHuAccents = /[áéíóöőúüű]/i.test(raw);
  const huWords = ['hogy', 'és', 'nem', 'kell', 'szerint', 'mi', 'milyen', 'mennyire', 'megfelel', 'kockázat', 'szabvány', 'tanús', 'törlés', 'kérdés'];
  const huHits = huWords.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0);
  if (hasHuAccents || huHits >= 2) return 'hu';

  // English fallback heuristic
  const enWords = ['the', 'and', 'not', 'must', 'should', 'analysis', 'risk', 'compliance', 'standard', 'compare', 'change'];
  const enHits = enWords.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0);
  if (enHits >= 2) return 'en';

  // Default: prefer Hungarian only when clearly indicated, otherwise English.
  return 'en';
}

function safeJsonParse(s) {
  try { return JSON.parse(String(s || '')); } catch { return null; }
}

function stripHeadersFooters(text) {
  // Conservative cleanup: remove page-number lines and highly repetitive boilerplate.
  const raw = String(text || '');
  if (!raw.trim()) return raw;

  const lines = raw.split(/\r?\n/);
  const normalized = lines.map(l => String(l || '').replace(/\s+/g, ' ').trim());

  const pageLine = (s) => {
    const t = String(s || '').trim();
    if (!t) return false;
    if (/^\d+\s*\/\s*\d+$/.test(t)) return true;                       // "3/12"
    if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return true;     // "Page 3 of 12" / "3 of 12" / "Page 3"
    if (/^-\s*\d+\s*-$/.test(t)) return true;                           // "- 3 -"
    return false;
  };

  // Build frequency table for short-ish lines (common headers/footers).
  const freq = new Map();
  for (const s of normalized) {
    if (!s) continue;
    if (s.length > 90) continue;
    // Ignore lines that are mostly digits/punctuation (handled by pageLine)
    if (/^[\d\s\-_/().]+$/.test(s)) continue;
    freq.set(s, (freq.get(s) || 0) + 1);
  }

  const boilerplate = (s) => /(confidential|all rights reserved|©|copyright)/i.test(s);

  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const s = normalized[i];
    if (!s) {
      cleaned.push(rawLine);
      continue;
    }
    if (pageLine(s)) continue;
    const c = freq.get(s) || 0;
    // Only strip repeated boilerplate, not general repeated phrases.
    if (c >= 2 && boilerplate(s)) continue;
    cleaned.push(rawLine);
  }

  return cleaned.join('\n');
}

function parseNumberLoose(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return NaN;
  const s0 = v.trim();
  if (!s0) return NaN;
  // Normalize "1 234,56" / "1,234.56" / "1234.56"
  const s1 = s0.replace(/\s+/g, '').replace(',', '.');
  // Strip trailing units/symbols (keep digits, dot, minus, exponent)
  const s2 = s1.replace(/[^0-9eE.+-]/g, '');
  const n = Number(s2);
  return Number.isFinite(n) ? n : NaN;
}

function computeColumnStats(rows, colIdx, { maxRows = 20000 } = {}) {
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < rows.length && r < maxRows; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const n = parseNumberLoose(row[colIdx]);
    if (!Number.isFinite(n)) continue;
    count++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    count,
    min: count ? min : null,
    max: count ? max : null,
    avg: count ? (sum / count) : null,
  };
}

function buildTablePreview(rows, { maxRows = 18, maxCols = 12 } = {}) {
  const out = [];
  const take = rows.slice(0, maxRows);
  for (let r = 0; r < take.length; r++) {
    const row = Array.isArray(take[r]) ? take[r] : [];
    const cells = row.slice(0, maxCols).map(v => {
      const s = String(v ?? '').replace(/\s+/g, ' ').trim();
      return s.length > 40 ? s.slice(0, 37) + '…' : s;
    });
    out.push(`[${r}] ${JSON.stringify(cells)}`);
  }
  return out.join('\n');
}

async function analyzeExcelColumnsWithLM(openaiClient, wb, { model, maxSheets = 6 } = {}) {
  const sheets = (wb?.SheetNames || []).slice(0, maxSheets);
  const previews = [];

  for (const sheet of sheets) {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, blankrows: false });
    if (!Array.isArray(rows) || !rows.length) continue;
    const head = buildTablePreview(rows.slice(0, 30), { maxRows: 14, maxCols: 12 });
    const tail = buildTablePreview(rows.slice(-30), { maxRows: 8, maxCols: 12 });
    previews.push(`SHEET: ${sheet}\nFIRST_ROWS:\n${head}\nLAST_ROWS:\n${tail}`);
  }

  if (!previews.length) return { sheets: [] };

  const sys = [
    'You are a data analyst extracting structure from spreadsheets.',
    'You do not know the column headers; infer structure from values and patterns.',
    'Return STRICT JSON only, no prose.',
    'Goal: pick up to 6 numeric measurement columns per sheet that are most relevant for safety/compliance/risk analysis.',
    'Avoid pure IDs, counters, timestamps unless they are central to the analysis.'
  ].join(' ');

  const user = [
    'For each sheet, infer up to 6 key numeric columns.',
    'Return JSON schema:',
    '{ "sheets": [ { "name": string, "columns": [ { "index": number, "label": string, "unit": string|null, "reason": string } ] } ] }',
    'Column index is 0-based within the row arrays shown.',
    '',
    previews.join('\n\n---\n\n')
  ].join('\n');

  const resp = await openaiClient.chat.completions.create({
    model: model || 'gpt-5-mini',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
  });
  const txt = String(resp?.choices?.[0]?.message?.content || '').trim();

  try {
    return JSON.parse(txt);
  } catch {
    // Try to salvage JSON object from mixed output
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { }
    }
    return { sheets: [] };
  }
}

async function extractFileToTextForRag(file, baseUrl, opts = {}) {
  const mt = String(file?.mimetype || '').toLowerCase();
  const name = String(file?.originalname || '');
  const lowerName = name.toLowerCase();

  try {
    if (mt === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const form = new FormData();
      form.append('file', file.buffer, { filename: name, contentType: file.mimetype || 'application/pdf' });
      form.append('certType', 'ATEX');
      const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, { headers: form.getHeaders(), timeout: 300000 });
      const txt = String(resp.data?.recognizedText || '');
      return stripHeadersFooters(txt);
    }
    if (mt.startsWith('image/')) {
      const form = new FormData();
      form.append('image', file.buffer, { filename: name, contentType: file.mimetype || 'application/octet-stream' });
      const upload = await axiosClient.post(`${baseUrl}/api/vision/upload`, form, { headers: form.getHeaders(), timeout: 300000 });
      const imageUrl = upload.data?.image_url;
      if (!imageUrl) return '';
      const analyze = await axiosClient.post(`${baseUrl}/api/vision/analyze`, {
        image_urls: [imageUrl],
        user_input: 'Extract all readable text and labels. If tables appear, describe them row-wise.'
      }, { timeout: 300000, headers: { 'Content-Type': 'application/json' } });
      return String(analyze.data?.result || '');
    }
    if (mt.includes('wordprocessingml') || lowerName.endsWith('.docx')) {
      const outRaw = await mammoth.extractRawText({ buffer: file.buffer });
      return stripHeadersFooters(String(outRaw?.value || ''));
    }
    if (mt.includes('msword') || lowerName.endsWith('.doc')) {
      try { return stripHeadersFooters(file.buffer.toString('utf8')); } catch { return ''; }
    }
    if (
      mt.includes('excel') || mt.includes('spreadsheetml') ||
      lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx')
    ) {
      const wb = xlsx.read(file.buffer, { type: 'buffer' });
      const parts = [];

      // Header-agnostic (LM-based) column selection + server-side stats.
      const enableExcelLm = String(opts.enableExcelLm ?? process.env.FILE_CHAT_EXCEL_LM ?? '1') !== '0';
      const excelModel = opts.excelModel || process.env.FILE_CHAT_EXCEL_MODEL || 'gpt-5-mini';
      if (enableExcelLm && opts.openai) {
        try {
          const spec = await analyzeExcelColumnsWithLM(opts.openai, wb, { model: excelModel });
          const sheetsSpec = Array.isArray(spec?.sheets) ? spec.sheets : [];

          if (sheetsSpec.length) {
            parts.push('--- EXCEL_STATS (auto-extracted; verify against original spreadsheet) ---');
            for (const sh of sheetsSpec.slice(0, 6)) {
              const sheetName = String(sh?.name || '');
              if (!sheetName || !wb.Sheets[sheetName]) continue;
              const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });
              const cols = Array.isArray(sh?.columns) ? sh.columns : [];
              const statsLines = [];
              for (const c of cols.slice(0, 6)) {
                const idx = Number(c?.index);
                if (!Number.isFinite(idx) || idx < 0) continue;
                const st = computeColumnStats(rows, idx, { maxRows: 20000 });
                if (!st.count) continue;
                const label = String(c?.label || `col_${idx}`);
                const unit = (c?.unit === null || c?.unit === undefined) ? '' : ` ${String(c.unit)}`;
                statsLines.push(`- ${label} (col ${idx})${unit}: max=${st.max}, min=${st.min}, avg=${st.avg}, n=${st.count}`);
              }
              if (statsLines.length) {
                parts.push(`SHEET: ${sheetName}`);
                parts.push(...statsLines);
              }
            }
            parts.push('--- END EXCEL_STATS ---\n');
          }
        } catch (e) {
          // Non-fatal: proceed with CSV text below.
          try { logger.warn('[CHAT_WITH_FILES_COMPLETIONS] Excel LM analysis failed:', e?.message); } catch { }
        }
      }

      wb.SheetNames.forEach(sheet => {
        const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false });
        parts.push(`-- SHEET: ${sheet} --\n${csv}`);
      });
      return parts.join('\n\n');
    }
    if (mt === 'text/plain' || lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.html')) {
      try { return file.buffer.toString('utf8'); } catch { return ''; }
    }

    try { return file.buffer.toString('utf8'); } catch { return ''; }
  } catch {
    return '';
  }
}

async function createEmbeddingVector(openaiClient, text, { embeddingModel }) {
  const input0 = sanitizeEmbeddingInput(text);
  const input = sanitizeEmbeddingInput(tokenTrim(input0, 800));
  if (!input) return [];

  try {
    const resp = await openaiClient.embeddings.create({
      model: embeddingModel,
      input: [input]
    });
    return resp.data?.[0]?.embedding || [];
  } catch (e) {
    try {
      logger.error('[CHAT_WITH_FILES_COMPLETIONS] embeddings.create failed', {
        model: embeddingModel,
        inputType: typeof input,
        inputChars: input.length,
        inputPreview: input.slice(0, 180),
        status: e?.response?.status || e?.status || null,
        serverMsg: e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || null,
        message: e?.message,
        code: e?.code || null,
        name: e?.name || null
      });
    } catch { }
    throw e;
  }
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-') // dashes
    .replace(/[^a-z0-9áéíóöőúüűßąćęłńśźż\-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordScore(query, text) {
  const q = normalizeForSearch(query);
  const t = normalizeForSearch(text);
  if (!q || !t) return 0;

  const phrase = q.length >= 10 ? q : '';
  const terms = q
    .split(' ')
    .filter(x => x.length >= 3)
    .slice(0, 14);
  if (!terms.length) return 0;

  let score = 0;
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g');
    const matches = t.match(re);
    if (matches?.length) score += matches.length;
  }
  if (phrase && t.includes(phrase)) score += 6;
  return score;
}

function chunkWithOverlap(text, { chunkTokens = 900, overlapTokens = 120 } = {}) {
  const ids = encoder.encode(String(text || ''));
  const chunks = [];
  if (!ids.length) return [''];
  const step = Math.max(1, chunkTokens - overlapTokens);
  for (let i = 0; i < ids.length; i += step) {
    const slice = ids.slice(i, Math.min(i + chunkTokens, ids.length));
    chunks.push(encoder.decode(slice));
    if (i + chunkTokens >= ids.length) break;
  }
  return chunks;
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
    try { res.end(); } catch { }
  });

  return send;
}
/** --- Rolling summary + HTML strip (context tone aid; not evidence) --- */
function stripHtml(input) {
  return String(input || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function buildRollingSummary(conversation) {
  try {
    const last = Array.isArray(conversation?.messages) ? conversation.messages.slice(-12) : [];
    const plain = last.map(m => `${String(m.role || '').toUpperCase()}: ${stripHtml(m.content)}`).join('\n');
    if (!plain) return '';
    const sys = 'Summarize the dialogue for the assistant to use as context. Be concise, neutral, 10–15 sentences. No action items, no fluff. Do not invent facts.';
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: process.env.SUMMARY_COMPLETIONS_MODEL || 'gpt-5-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: plain }]
    }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
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
          try { send(event, payload); } catch { }
        },
        patch: async (patchObj) => {
          try { await jobPatch(conversation, patchObj); } catch { }
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
      try { await jobFail(conversation, error); } catch { }
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
      const reduceTabularHint = buildTabularHint(question);

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
          'You are a helpful, precise assistant (ChatGPT style).',
          'Answer **only** using the provided CONTEXT CHUNK.',
          'If the answer is not present in this chunk, reply exactly: "Not found in this chunk."',
          'If relevant text is present, provide the minimal necessary answer with brief supporting quotes and include the source filename from the chunk header when that adds value.',
          'Be concise; avoid boilerplate sections. Use Markdown only if it improves clarity.',
          'Respond in the same language as the user question.',
          'Prefer concise answers; use a short Markdown table only if it clearly improves clarity for this chunk.'
        ].join(' ');

        const systemReduceBase = [
          'You are a helpful, precise assistant (ChatGPT style).',
          'Synthesize the final answer **only** from the provided FINDINGS and the user question.',
          'Structure the response dynamically. If a brief direct answer suffices, present it first, followed by essential evidence only as needed.',
          'Resolve contradictions by preferring the most specific and directly quoted evidence.',
          'If the information is not present overall, say exactly: "Not found in provided files."',
          'Cite filenames inline only when it helps attribution. Avoid unnecessary sections.',
          'Respond in the same language as the user\'s question.',
          'If the task implies analysis/compliance/metrics, include a compact Markdown table (≤10 columns, ≤30 rows) where it improves clarity; otherwise use clear prose.',
          'If crucial details are missing, ask one concise clarifying question at the top, then proceed with the best-possible answer.'
        ].join(' ');
        const systemReduce = reduceTabularHint ? `${systemReduceBase} ${reduceTabularHint}` : systemReduceBase;

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
                try { send('assistant.status', { stage: `${stageLabel}.fail`, model: modelName, status, error: err?.message || 'error' }); } catch { }
                throw err;
              }
              let pause = wait;
              const ra = err?.response?.headers?.['retry-after'];
              if (ra) {
                const raMs = Number(ra) * 1000;
                if (!Number.isNaN(raMs) && raMs > 0) pause = Math.max(pause, raMs);
              }
              try { send('assistant.status', { stage: `${stageLabel}.retry`, attempt, waitMs: pause, status }); } catch { }
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
            try { send('token', { delta: '\n' }); } catch { }
          } catch {
            reply = await chatWithRetry(modelFallback, mapMessages, 'map.fallback');
            send('assistant.status', { stage: 'map.fallback.ok', index: i + 1, total: chunks.length, model: modelFallback });
            try { send('token', { delta: '\n' }); } catch { }
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
                { role: 'user', content: `FINDINGS (batch ${i + 1}/${batches.length}):\n\n${bJoined}\n\nQUESTION:\n${question}\n\nReturn a concise, well-structured summary WITH exact quotes and source filenames.` }
              ];
              let summary = '';
              try {
                summary = await chatWithRetry(modelPrimary, msg, `reduce.primary.batch${i + 1}.round${round}`);
                send('assistant.status', { stage: 'reduce.primary.ok', model: modelPrimary, round, batch: i + 1 });
              } catch {
                summary = await chatWithRetry(modelFallback, msg, `reduce.fallback.batch${i + 1}.round${round}`);
                send('assistant.status', { stage: 'reduce.fallback.ok', model: modelFallback, round, batch: i + 1 });
              }
              next.push(summary.trim());
              // lightweight progress ping for UI
              try { send('token', { delta: '\n' }); } catch { }
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
          allowedTags: ['a', 'b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
          allowedAttributes: { 'span': ['class'], 'a': ['href', 'title', 'target', 'rel'] },
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

// ===== Chat-with-files via Chat Completions (gpt-5 capable), without Assistants vector stores (SSE) =====
// POST /api/chat/with-files-completions/stream
// - multipart/form-data: files[], threadId, message, mode=hybrid|sandbox
// - hybrid: persist chunks+embeddings in Mongo (RagChunk) per thread
// - sandbox: use only currently uploaded files (no DB persistence)
exports.chatWithFilesCompletionsStream = async (req, res) => {
  const send = sseInit(req, res);

  let conversation;
  try {
    const t0 = Date.now();
    const { mode: rawMode, message, threadId } = req.body || {};
    const mode = (rawMode === 'sandbox' ? 'sandbox' : 'hybrid');
    const userId = req.userId;
    const reqCt = String(req.headers?.['content-type'] || '');
    const reqLen = Number(req.headers?.['content-length'] || 0) || null;

    const logHttpError = (label, err) => {
      try {
        const status = err?.response?.status;
        const hdrs = err?.response?.headers || {};
        const reqId =
          hdrs['x-request-id'] ||
          hdrs['openai-request-id'] ||
          hdrs['request-id'] ||
          null;
        const serverMsg = err?.response?.data?.error?.message || err?.response?.data?.message || null;
        logger.error(`[CHAT_WITH_FILES_COMPLETIONS] ${label}`, {
          status,
          reqId,
          serverMsg,
          message: err?.message,
          stack: err?.stack,
        });
      } catch {
        logger.error(`[CHAT_WITH_FILES_COMPLETIONS] ${label}: ${err?.message || err}`);
      }
    };

    const headersAssistantsV2 = (extra = {}) => ({
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'assistants=v2',
      ...extra
    });

    async function getAssistantVectorStoreId(assistantId) {
      if (!assistantId) return null;
      try {
        const r = await axios.get(
          `https://api.openai.com/v1/assistants/${assistantId}`,
          { headers: headersAssistantsV2() }
        );
        const ids = r.data?.tool_resources?.file_search?.vector_store_ids || [];
        return ids[0] || null;
      } catch (e) {
        logger.warn('[CHAT_WITH_FILES_COMPLETIONS] getAssistantVectorStoreId failed', e?.response?.data || e?.message);
        return null;
      }
    }

    function coerceSearchText(maybe) {
      if (!maybe) return '';
      if (typeof maybe === 'string') return maybe;
      if (Array.isArray(maybe)) {
        return maybe
          .map(x => (typeof x === 'string' ? x : (x?.text || x?.text?.value || x?.content || '')))
          .filter(Boolean)
          .join('');
      }
      if (typeof maybe === 'object') return String(maybe.text || maybe?.text?.value || maybe.content || '');
      return String(maybe);
    }

    async function searchVectorStore(vectorStoreId, query, limit = 5) {
      if (!vectorStoreId || !query) return [];
      const url = `https://api.openai.com/v1/vector_stores/${vectorStoreId}/search`;
      try {
        const r = await axios.post(
          url,
          { query: String(query), max_num_results: Math.max(1, Math.min(limit, 20)) },
          { headers: headersAssistantsV2({ 'Content-Type': 'application/json' }) }
        );
        return r.data?.data || r.data?.results || [];
      } catch (e) {
        logger.warn('[CHAT_WITH_FILES_COMPLETIONS] vector store search failed', {
          status: e?.response?.status,
          message: e?.response?.data?.error?.message || e?.message
        });
        return [];
      }
    }

    if (!userId) {
      send('error', { message: 'Hiányzó vagy érvénytelen JWT.' });
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

    const user = await User.findById(userId).select('tenantId');
    const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
    if (!tenantId) {
      send('error', { message: 'Hiányzó tenant azonosító.' });
      send('done', { ok: false });
      return res.end();
    }

    conversation = await Conversation.findOne({ threadId, userId, tenantId });
    if (!conversation) {
      send('error', { message: 'A megadott szál nem található.' });
      send('done', { ok: false });
      return res.end();
    }

    const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';
    const completionsPrimary = process.env.FILE_CHAT_COMPLETIONS_MODEL || 'gpt-5-mini';
    const completionsFallback = process.env.FILE_CHAT_COMPLETIONS_FALLBACK || 'gpt-4o-mini';

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let embeddingsEnabled = true;
    let embeddingsDisabledReason = null;
    const embeddingStatus = (err) => (err?.response?.status || err?.status || 0);
    const isEmbeddingForbidden = (err) => embeddingStatus(err) === 403;

    // ---- 1) Prepare chunks (hybrid: persist; sandbox: ephemeral) ----
    const uploads = Array.isArray(req.files) ? req.files : [];
    const nowFiles = uploads.map(f => f.originalname).filter(Boolean);

    logger.info('[CHAT_WITH_FILES_COMPLETIONS] start', {
      threadId,
      userId: String(userId),
      tenantId: String(tenantId),
      mode,
      uploads: uploads.length,
      files: nowFiles,
      contentType: reqCt,
      contentLength: reqLen,
      embeddingModel,
      completionsPrimary,
      completionsFallback,
    });

    send('progress', { stage: 'rag.prepare', mode, uploads: uploads.length });

    let ephemeralChunks = []; // { filename, chunkIndex, text, tokens, embedding }

    if (mode === 'sandbox') {
      // sandbox: do not touch DB; build in-memory chunks
      for (const f of uploads) {
        const fileT0 = Date.now();
        send('progress', { stage: 'rag.extract', file: f.originalname });
        logger.info('[CHAT_WITH_FILES_COMPLETIONS] extracting (sandbox)', { file: f.originalname, size: f.size, mimetype: f.mimetype });
        let safeText = '';
        let limited = [];
        try {
          const text = await extractFileToTextForRag(f, baseUrl, { openai, enableExcelLm: true });
          safeText = String(text || '').replace(/\u0000/g, '');
          const chunks = chunkWithOverlap(safeText, { chunkTokens: 900, overlapTokens: 120 }).filter(x => String(x || '').trim());
          limited = chunks.slice(0, 80);
        } catch (e) {
          logger.error('[CHAT_WITH_FILES_COMPLETIONS] chunking failed (sandbox)', {
            file: f.originalname,
            message: e?.message,
            stack: e?.stack,
            textType: typeof safeText,
            textPreview: String(safeText || '').slice(0, 200)
          });
          throw e;
        }
        logger.info('[CHAT_WITH_FILES_COMPLETIONS] extracted (sandbox)', {
          file: f.originalname,
          chars: safeText.length,
          chunks: limited.length,
          ms: Date.now() - fileT0
        });
        send('progress', { stage: 'rag.chunk', file: f.originalname, chunks: limited.length });
        for (let i = 0; i < limited.length; i++) {
          const chunkText = String(limited[i] ?? '');
          if (!sanitizeEmbeddingInput(chunkText)) {
            send('progress', { stage: 'rag.skipChunk', file: f.originalname, chunk: i + 1, reason: 'empty_or_invalid' });
            continue;
          }
          let tokens = 0;
          try {
            tokens = encoder.encode(chunkText).length;
          } catch (e) {
            logger.error('[CHAT_WITH_FILES_COMPLETIONS] tokenization failed (sandbox)', {
              file: f.originalname,
              chunk: i,
              chunkType: typeof chunkText,
              chunkPreview: String(chunkText || '').slice(0, 200),
              message: e?.message,
              stack: e?.stack
            });
            throw e;
	          }
	          send('progress', { stage: 'rag.embed', file: f.originalname, chunk: i + 1, total: limited.length });
	          let embedding = [];
	          if (embeddingsEnabled) {
	            try {
	              embedding = await createEmbeddingVector(openai, chunkText, { embeddingModel });
	            } catch (e) {
	              if (isEmbeddingForbidden(e)) {
	                embeddingsEnabled = false;
	                embeddingsDisabledReason = `embeddings forbidden (403) model=${embeddingModel}`;
	                logger.warn('[CHAT_WITH_FILES_COMPLETIONS] embeddings disabled, falling back to keyword retrieval', { reason: embeddingsDisabledReason });
	                try { send('progress', { stage: 'rag.embed.disabled', reason: '403_forbidden' }); } catch { }
	                embedding = [];
	              } else {
	                logHttpError(`embedding failed (sandbox) file=${f.originalname} chunk=${i}`, e);
	                throw e;
	              }
	            }
	          }
	          ephemeralChunks.push({ filename: f.originalname, chunkIndex: i, text: chunkText, tokens, embedding });
	        }
	      }
	    } else {
      // hybrid: persist to RagChunk per threadId (skip duplicates by content hash)
      for (const f of uploads) {
        const fileT0 = Date.now();
        const fileHash = crypto.createHash('sha256').update(f.buffer).update(f.originalname || '').digest('hex');
        const already = await RagChunk.exists({ threadId, tenantId, filename: f.originalname, fileHash });
        if (already) {
          send('progress', { stage: 'rag.skip', file: f.originalname, reason: 'already_ingested' });
          logger.info('[CHAT_WITH_FILES_COMPLETIONS] skip ingest (already)', { file: f.originalname, fileHash });
          continue;
        }

        // Replace any earlier version of the same filename in this thread
        await RagChunk.deleteMany({ threadId, tenantId, filename: f.originalname }).catch((e) => {
          logger.warn('[CHAT_WITH_FILES_COMPLETIONS] failed to delete prior chunks', { file: f.originalname, message: e?.message });
        });

        send('progress', { stage: 'rag.extract', file: f.originalname });
        logger.info('[CHAT_WITH_FILES_COMPLETIONS] extracting (hybrid)', { file: f.originalname, size: f.size, mimetype: f.mimetype, fileHash });
        let safeText = '';
        let limited = [];
        try {
          const text = await extractFileToTextForRag(f, baseUrl, { openai, enableExcelLm: true });
          safeText = String(text || '').replace(/\u0000/g, '');
          const chunks = chunkWithOverlap(safeText, { chunkTokens: 900, overlapTokens: 120 }).filter(x => String(x || '').trim());
          limited = chunks.slice(0, 80);
        } catch (e) {
          logger.error('[CHAT_WITH_FILES_COMPLETIONS] chunking failed (hybrid)', {
            file: f.originalname,
            fileHash,
            message: e?.message,
            stack: e?.stack,
            textType: typeof safeText,
            textPreview: String(safeText || '').slice(0, 200)
          });
          throw e;
        }
        logger.info('[CHAT_WITH_FILES_COMPLETIONS] extracted (hybrid)', {
          file: f.originalname,
          chars: safeText.length,
          chunks: limited.length,
          ms: Date.now() - fileT0
        });
        send('progress', { stage: 'rag.chunk', file: f.originalname, chunks: limited.length });

        const docs = [];
        for (let i = 0; i < limited.length; i++) {
          const chunkText = String(limited[i] ?? '');
          if (!sanitizeEmbeddingInput(chunkText)) {
            send('progress', { stage: 'rag.skipChunk', file: f.originalname, chunk: i + 1, reason: 'empty_or_invalid' });
            continue;
          }
          let tokens = 0;
          try {
            tokens = encoder.encode(chunkText).length;
          } catch (e) {
            logger.error('[CHAT_WITH_FILES_COMPLETIONS] tokenization failed (hybrid)', {
              file: f.originalname,
              fileHash,
              chunk: i,
              chunkType: typeof chunkText,
              chunkPreview: String(chunkText || '').slice(0, 200),
              message: e?.message,
              stack: e?.stack
            });
            throw e;
	          }
	          send('progress', { stage: 'rag.embed', file: f.originalname, chunk: i + 1, total: limited.length });
	          let embedding = [];
	          if (embeddingsEnabled) {
	            try {
	              embedding = await createEmbeddingVector(openai, chunkText, { embeddingModel });
	            } catch (e) {
	              if (isEmbeddingForbidden(e)) {
	                embeddingsEnabled = false;
	                embeddingsDisabledReason = `embeddings forbidden (403) model=${embeddingModel}`;
	                logger.warn('[CHAT_WITH_FILES_COMPLETIONS] embeddings disabled, falling back to keyword retrieval', { reason: embeddingsDisabledReason });
	                try { send('progress', { stage: 'rag.embed.disabled', reason: '403_forbidden' }); } catch { }
	                embedding = [];
	              } else {
	                logHttpError(`embedding failed (hybrid) file=${f.originalname} chunk=${i}`, e);
	                throw e;
	              }
	            }
	          }
	          docs.push({
	            threadId,
	            tenantId,
	            userId,
            filename: f.originalname,
            fileHash,
            chunkIndex: i,
            text: chunkText,
            tokens,
            embedding
          });
        }
        if (docs.length) {
          try {
            await RagChunk.insertMany(docs);
          } catch (e) {
            logger.error('[CHAT_WITH_FILES_COMPLETIONS] RagChunk insertMany failed', { file: f.originalname, chunks: docs.length, message: e?.message });
            throw e;
          }
          send('progress', { stage: 'rag.ingested', file: f.originalname, chunks: docs.length });
          logger.info('[CHAT_WITH_FILES_COMPLETIONS] ingested', { file: f.originalname, chunks: docs.length });
        } else {
          send('progress', { stage: 'rag.ingested', file: f.originalname, chunks: 0 });
          logger.warn('[CHAT_WITH_FILES_COMPLETIONS] ingested empty', { file: f.originalname });
        }
      }
    }

	    // ---- 2) Retrieve relevant chunks ----
	    send('progress', { stage: 'rag.search.start' });
	    let qEmbedding = [];
	    if (embeddingsEnabled) {
	      try {
	        qEmbedding = await createEmbeddingVector(openai, message, { embeddingModel });
	      } catch (e) {
	        if (isEmbeddingForbidden(e)) {
	          embeddingsEnabled = false;
	          embeddingsDisabledReason = `question embeddings forbidden (403) model=${embeddingModel}`;
	          logger.warn('[CHAT_WITH_FILES_COMPLETIONS] embeddings disabled at question step, falling back to keyword retrieval', { reason: embeddingsDisabledReason });
	          try { send('progress', { stage: 'rag.embed.disabled', reason: '403_forbidden' }); } catch { }
	          qEmbedding = [];
	        } else {
	          logHttpError('question embedding failed', e);
	          throw e;
	        }
	      }
	    }

    let candidates = [];
    if (mode === 'sandbox') {
      candidates = ephemeralChunks;
    } else {
      try {
        candidates = await RagChunk.find({ threadId, tenantId })
          .select('filename chunkIndex text tokens embedding')
          .limit(4000)
          .lean();
      } catch (e) {
        logger.error('[CHAT_WITH_FILES_COMPLETIONS] RagChunk find failed', { threadId, tenantId: String(tenantId), message: e?.message });
        throw e;
      }
    }

    const candidatesWithEmb = (candidates || []).filter(c => Array.isArray(c.embedding) && c.embedding.length);

	    // Intent-aware retrieval: add a few sub-queries for broader questions (more like web UI).
	    const intent = detectIntent(message);
	    const lang = detectLanguage(message);
	    const subQueries = (() => {
	      if (intent === 'nb_audit') return [
	        'compliance requirements and marking',
	        'temperature / surface temperature / Ts / Tc evidence',
        'tests, certificates, reports, IP/IK, safety measures',
      ];
      if (intent === 'comparison') return [
        'differences between documents/versions/specifications',
        'changed values, requirements, limits, markings',
      ];
      if (intent === 'what_changed') return [
        'changes, revisions, updates, modified values',
        'added/removed requirements or notes',
      ];
      if (intent === 'standards') return [
        'standards mentioned, clauses, requirements',
        'compliance checklist and obligations',
      ];
      if (intent === 'exec_summary') return [
        'key findings, key risks, decision points',
        'recommendations and next steps',
      ];
      if (intent === 'howto') return [
        'procedure, steps, method described',
        'inputs/outputs, responsibilities, workflow',
      ];
      return [];
    })();

	    let scoredAll = [];
	    if (embeddingsEnabled && Array.isArray(qEmbedding) && qEmbedding.length && candidatesWithEmb.length) {
	      const embeddings = [qEmbedding];
	      for (const sq of subQueries.slice(0, 3)) {
	        try {
	          const e = await createEmbeddingVector(openai, `${message}\n\n${sq}`, { embeddingModel });
	          if (Array.isArray(e) && e.length) embeddings.push(e);
	        } catch {
	          // non-fatal: keep base embedding
	        }
	      }
	
	      // Score by maximum similarity across embeddings (question + sub-queries)
	      scoredAll = candidatesWithEmb
	        .map(c => {
	          let best = -Infinity;
	          for (const e of embeddings) {
	            const s = cosineSimilarity(e, c.embedding);
	            if (s > best) best = s;
	          }
	          return { ...c, _score: best };
	        })
	        .sort((a, b) => b._score - a._score);
	    } else {
	      const queries = [message, ...subQueries].slice(0, 4);
	      scoredAll = (candidates || [])
	        .map(c => {
	          let best = 0;
	          for (const q of queries) {
	            const s = keywordScore(q, c.text);
	            if (s > best) best = s;
	          }
	          return { ...c, _score: best };
	        })
	        .sort((a, b) => b._score - a._score);
	    }

    // Retrieval strategy (more "ChatGPT UI-like" for broad prompts):
    // - keep some per-file coverage (topKPerFile)
    // - also keep a small global topK to catch the best hits
    const topKPerFile = 3;
    const globalTopK = 8;
    const maxTotal = 18;

    const perFile = new Map(); // filename -> entries[]
    for (const s of scoredAll) {
      const fn = String(s.filename || '');
      if (!fn) continue;
      const arr = perFile.get(fn) || [];
      if (arr.length < topKPerFile) {
        arr.push(s);
        perFile.set(fn, arr);
      }
    }

    const picked = [];
    const seenKey = new Set();
    const pushUnique = (s) => {
      const key = `${s.filename}#${s.chunkIndex}`;
      if (seenKey.has(key)) return;
      seenKey.add(key);
      picked.push(s);
    };

    // 1) global best hits
    scoredAll.slice(0, globalTopK).forEach(pushUnique);
    // 2) per-file top hits
    for (const arr of perFile.values()) arr.forEach(pushUnique);

    // 3) ensure first chunk per file is present (often contains title/scope)
    const firstByFile = new Map();
    for (const c of candidates || []) {
      const fn = String(c.filename || '');
      if (!fn) continue;
      if (Number(c.chunkIndex) === 0 && !firstByFile.has(fn)) firstByFile.set(fn, c);
    }
    for (const [fn, c] of firstByFile.entries()) {
      if (picked.length >= maxTotal) break;
      pushUnique({ ...c, _score: 0 });
    }

    const scored = picked.slice(0, maxTotal);

    const filesInScope = Array.from(new Set([
      ...(mode === 'sandbox' ? nowFiles : []),
      ...(mode === 'hybrid' ? (candidates || []).map(x => x.filename).filter(Boolean) : [])
    ])).slice(0, 50);

    const safeFilename = (filename) => String(filename || '').trim() || 'unknown';

    const contextBlock = scored.length
      ? scored.map(s => `SOURCE: ${safeFilename(s.filename)}\n${s.text}`).join('\n\n---\n\n')
      : '';

    // ---- 2b) Optional: include assistant vector-store as BACKGROUND KB (secondary, not "evidence") ----
    // Goal:
    // - Improve "web-like" accuracy/coverage via curated KB, while keeping uploaded files as the primary source.
    // - Never claim KB facts come from uploaded files; keep it clearly separated.
    const wantsBackgroundKb = String(process.env.FILE_CHAT_BACKGROUND_VS || '1') !== '0';
    let backgroundKbBlock = '';
    if (wantsBackgroundKb) {
      try {
        send('progress', { stage: 'kb.search.start' });
        const tenantDoc = await Tenant.findById(tenantId).select('name').lean();
        const tenantKey = String(tenantDoc?.name || '').toLowerCase();
        const assistantId = assistants.byTenant?.[tenantKey] || assistants['default'];
        const vectorStoreId = await getAssistantVectorStoreId(assistantId);
        if (vectorStoreId) {
          const envHits = Number(process.env.FILE_CHAT_BACKGROUND_VS_HITS || 0);
          const envMax = Number(process.env.FILE_CHAT_BACKGROUND_VS_MAX || 0);
          const envPerFile = Number(process.env.FILE_CHAT_BACKGROUND_VS_PER_FILE || 0);
          const hitsPerQueryBase = (envHits > 0 ? envHits : 6);
          const maxItemsBase = (envMax > 0 ? envMax : 14);
          const perFileBase = (envPerFile > 0 ? envPerFile : 3);

          const isKnowledgeHeavy = intent === 'standards' || intent === 'nb_audit';
          const hitsPerQuery = isKnowledgeHeavy ? Math.max(hitsPerQueryBase, 10) : hitsPerQueryBase;
          const maxItems = isKnowledgeHeavy ? Math.max(maxItemsBase, 24) : maxItemsBase;
          const perFileLimit = isKnowledgeHeavy ? Math.max(perFileBase, 4) : perFileBase;

          const kbQueries = [message, ...subQueries].slice(0, isKnowledgeHeavy ? 4 : 3);
          const raw = [];
          for (const q of kbQueries) {
            const hits = await searchVectorStore(vectorStoreId, q, hitsPerQuery);
            raw.push(...(hits || []));
          }

          // Normalize + rank.
          const normalized = (raw || []).map(it => {
            const fileId = it.file_id || it.fileId || it.file?.id || it?.file?.file_id || null;
            const score = typeof it.score === 'number' ? it.score : (typeof it._score === 'number' ? it._score : null);
            const text =
              coerceSearchText(it.content) ||
              coerceSearchText(it.text) ||
              coerceSearchText(it?.chunk?.text) ||
              '';
            const clean = String(text || '').trim();
            return { fileId, score: (typeof score === 'number' ? score : 0), text: clean };
          }).filter(x => x.text);

          normalized.sort((a, b) => b.score - a.score);

          // Dedupe + cap per file for coverage.
          const byKey = new Map();
          const perFileCount = new Map();
          for (const it of normalized) {
            const fileId = it.fileId || null;
            const clean = String(it.text || '').trim();
            if (!clean) continue;
            const already = perFileCount.get(fileId || 'kb') || 0;
            if (already >= perFileLimit) continue;
            const key = `${fileId || 'kb'}::${clean.slice(0, 240)}`;
            if (byKey.has(key)) continue;
            byKey.set(key, { fileId, score: it.score, text: clean.slice(0, 1800) });
            perFileCount.set(fileId || 'kb', already + 1);
            if (byKey.size >= maxItems) break;
          }

          const items = Array.from(byKey.values()).slice(0, maxItems);

          // Best-effort filename enrichment (only for top few unique file IDs)
          const fileIds = Array.from(new Set(items.map(x => x.fileId).filter(Boolean))).slice(0, 10);
          const idToName = new Map();
          for (const fid of fileIds) {
            try {
              const fr = await axios.get(`https://api.openai.com/v1/files/${fid}`, {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
              });
              idToName.set(fid, fr.data?.filename || fid);
            } catch {
              idToName.set(fid, fid);
            }
          }

          if (items.length) {
            backgroundKbBlock = items
              .map(x => {
                const name = x.fileId ? (idToName.get(x.fileId) || x.fileId) : 'KB';
                return `KB_SOURCE: ${safeFilename(name)}\n${x.text}`;
              })
              .join('\n\n---\n\n');
          }
        }
        send('progress', { stage: 'kb.search.done', hits: backgroundKbBlock ? backgroundKbBlock.split('\n\n---\n\n').length : 0 });
      } catch (e) {
        logger.warn('[CHAT_WITH_FILES_COMPLETIONS] background KB failed', e?.response?.data || e?.message);
        try { send('progress', { stage: 'kb.search.done', hits: 0 }); } catch { }
      }
    }

	    // Surface retrieval strategy to UI/logs (helps debugging when embeddings are forbidden)
	    try {
	      send('progress', {
	        stage: 'rag.search.strategy',
	        strategy: embeddingsEnabled ? 'embeddings' : 'keyword',
	        reason: embeddingsDisabledReason || null
	      });
	    } catch { }

	    send('progress', { stage: 'rag.search.done', hits: scored.length, files: filesInScope.length });
	    logger.info('[CHAT_WITH_FILES_COMPLETIONS] retrieval', {
	      mode,
	      candidates: (candidates || []).length,
	      hits: scored.length,
	      embeddingsEnabled,
	      embeddingsDisabledReason,
	      top: scored.slice(0, 5).map(s => ({
	        file: s.filename,
	        chunk: s.chunkIndex,
	        score: Number.isFinite(s?._score) ? Number(s._score.toFixed(4)) : null
	      }))
	    });

    // ---- 3) Optional evidence-summaries (per file) to make broad requests more "web UI-like" ----
    const wantsEvidencePass = String(process.env.FILE_CHAT_EVIDENCE_PASS || '1') !== '0';
    const evidenceSummaries = [];

    const retryable = (status) => status === 429 || (status >= 500 && status < 600);
    async function chatOnceWithRetry(modelName, messages, label) {
      let attempt = 0;
      let delayMs = 800;
      while (attempt < 5) {
        attempt++;
        try {
          const r = await openai.chat.completions.create({ model: modelName, messages });
          return String(r?.choices?.[0]?.message?.content || '');
        } catch (e) {
          const status = e?.response?.status || 0;
          if (!retryable(status) || attempt >= 5) throw e;
          try { send('progress', { stage: 'assistant.retry', label, attempt, status, waitMs: delayMs }); } catch { }
          await delay(delayMs);
          delayMs = Math.min(delayMs * 2, 8000);
        }
      }
      return '';
    }

    if (wantsEvidencePass && scored.length) {
      send('progress', { stage: 'evidence.start', files: filesInScope.length });
      const byFile = new Map();
      for (const s of scored) {
        const fn = String(s.filename || '');
        if (!fn) continue;
        const arr = byFile.get(fn) || [];
        arr.push(s);
        byFile.set(fn, arr);
      }
      for (const [fn, arr] of byFile.entries()) {
        send('progress', { stage: 'evidence.file', file: fn });
        const snippets = arr.slice(0, 6).map(s => `SOURCE: ${safeFilename(fn)}\n${s.text}`).join('\n\n---\n\n');
        const sys = [
          'You are extracting evidence from a single document snippet.',
          'Return 5–10 bullet points of concrete, verifiable claims/facts found in the snippet.',
          'If the snippet contains measurements, limits, labels/markings, materials, IP/IK ratings, temperatures, or test outcomes, include the numeric values verbatim.',
          'Do not invent clauses or requirements. Do not ask clarifying questions.',
          'Keep it short and factual.'
        ].join(' ');
        const msgs = [
          { role: 'system', content: sys },
          { role: 'user', content: `FILENAME: ${safeFilename(fn)}\n\nSNIPPETS:\n${snippets}` }
        ];
        let summaryText = '';
        try {
          summaryText = await chatOnceWithRetry(completionsPrimary, msgs, 'evidence.primary');
        } catch (e) {
          summaryText = await chatOnceWithRetry(completionsFallback, msgs, 'evidence.fallback');
        }
        if (summaryText && summaryText.trim()) {
          evidenceSummaries.push(`FILE: ${safeFilename(fn)}\n${summaryText.trim()}`);
        }
      }
      send('progress', { stage: 'evidence.done', files: evidenceSummaries.length });
    }

    // ---- 4) Build prompt (closest to OpenAI UI: strong grounding + best-effort) ----
    const history = (Array.isArray(conversation.messages) ? conversation.messages : [])
      .slice(-10)
      .map(m => `${String(m.role || '').toUpperCase()}: ${stripHtml(m.content || '')}`)
      .join('\n');

    const wantsCompliance =
      /megfelel|megfelelős|kockázat|risk|compliance|audit|atex|iecex|60079/i.test(String(message || ''));

	    // Web-style always: concise, dynamic structure, like ChatGPT UI.
	    // Optional: small format planner to keep answers web-like but question-dependent.
	    const wantsFormatPlanner = String(process.env.FILE_CHAT_FORMAT_PLANNER || '1') !== '0';
	    const plannerModel = process.env.FILE_CHAT_FORMAT_PLANNER_MODEL || completionsPrimary;
	    let plan = null;
	    if (wantsFormatPlanner) {
	      try {
	        send('progress', { stage: 'planner.start', model: plannerModel });
	        const plannerSys = [
	          'You are a response-format planner for an AI assistant.',
	          'Given a user question and file list, choose the best web-chat style structure.',
	          'Return ONLY valid JSON.',
	          'Do not include markdown or prose.',
	          'Keys:',
	          '- language: "hu" | "en"',
	          '- intent: "nb_audit" | "comparison" | "what_changed" | "standards" | "exec_summary" | "howto" | "general"',
	          '- executive: boolean (true = leadership/consultant tone if appropriate)',
	          '- structure: short string describing section titles (in the target language)',
	          '- length: "short" | "medium" | "long"',
	          '- ask_clarifying: boolean (only if strictly required)',
	          '- clarifying_question: string (empty if not needed)'
	        ].join(' ');
	        const plannerUser = [
	          `language_hint=${lang}`,
	          `intent_hint=${intent}`,
	          `files=${(filesInScope || []).slice(0, 30).join(' | ')}`,
	          `question=${String(message || '').slice(0, 3000)}`
	        ].join('\n');
	        const pr = await openai.chat.completions.create({
	          model: plannerModel,
	          messages: [
	            { role: 'system', content: plannerSys },
	            { role: 'user', content: plannerUser }
	          ]
	        });
	        const content = String(pr?.choices?.[0]?.message?.content || '').trim();
	        const parsed = safeJsonParse(content);
	        if (parsed && typeof parsed === 'object') plan = parsed;
	        send('progress', { stage: 'planner.done', ok: !!plan });
	      } catch (e) {
	        logger.warn('[CHAT_WITH_FILES_COMPLETIONS] planner failed', e?.response?.data || e?.message);
	        try { send('progress', { stage: 'planner.done', ok: false }); } catch { }
	        plan = null;
	      }
	    }

	    const systemBase = [
	      'You are a helpful, precise assistant in the style of ChatGPT.',
	      'Use the provided FILE CONTEXT and EVIDENCE SUMMARIES as the primary source of truth.',
	      'If BACKGROUND KB is present, use it as secondary background knowledge to improve accuracy and fill gaps, but keep the uploaded files as the primary focus.',
	      'Never claim BACKGROUND KB facts come from the uploaded files.',
	      'Do NOT output a separate "Háttértudás" section; use background knowledge silently. If you must qualify a statement, do it inline with a short prefix like: "Általános szabványismeret alapján:" or "Általános háttértudás alapján:".',
	      'Do NOT invent certificate numbers, test reports, or test outcomes for the specific product/documents.',
	      'Clause numbers: only mention a clause number if it appears in the provided excerpts; otherwise do not cite clause numbers.',
	      'Numeric limits/definitions: if not present in the provided excerpts, you may still state widely-known standard knowledge ONLY when you clearly label it as general knowledge (not file evidence) and you are confident; if uncertain, say it is not verified here.',
	      'Do not start the answer with "Rövid válasz" or "Short conclusion". Start directly with the analysis.',
	      'You MAY reference filenames when it helps attribution, but do NOT mention chunk numbers or any internal identifiers.',
	      'Structure the answer like the ChatGPT web UI: start with 1–2 direct sentences (no label like "Rövid összefoglaló"), then concise headings and short lists/tables as needed (no boilerplate).',
	      'Respond in the same language as the user message, including section titles; do not mix languages in a single response.'
	    ];
	
	    const systemAuditWebFor = (l) => (l === 'hu')
	      ? [
	        'Ha a user megfelelőség/kockázat/audit jellegű elemzést kér:',
	        '- Használd (ha releváns) az alábbi fő részeket, röviden, webes ChatGPT stílusban:',
	        '  1) Megfelelőségi elemzés',
	        '  2) Hőmérséklet és határértékek',
	        '  3) Kockázatok (rövid táblázat + 3–6 bullet)',
	        '  4) Következtetés',
	        '  5) Következő lépések',
	        '- A fenti 5 pont legyen a fő szerkezet: ne adj külön top-level szekciókat mint "Alkalmazott dokumentumok", "Melléklet", "Prioritások/ütemterv", "Clause-by-clause".',
	        '- Ne írj felelős/határidő bontást, timeline-t vagy mellékleteket, csak ha a user kéri.',
	        '- A leírás legyen döntés‑kész, kerülje a hosszú szabványelméletet.',
	        '- Ha van EXCEL_STATS, használd a max/min értékeket; ha a limit nem szerepel az anyagban, akkor csak háttértudásként (inline jelöléssel) említsd, vagy jelezd, hogy nincs itt igazolva.'
	      ]
	      : [
	        'If the user asks for compliance/risk/audit:',
	        '- Use these main sections (if relevant), concise and web-ChatGPT-like:',
	        '  1) Compliance',
	        '  2) Temperature & Limits',
	        '  3) Risks (short table + 3–6 bullets)',
	        '  4) Conclusion',
	        '  5) Next Steps',
	        '- Keep these 5 as the main structure: do not add separate top-level sections like "Evidence inventory", "Appendix", "Timeline", or "Clause-by-clause".',
	        '- Do not assign owners/deadlines unless the user asks.',
	        '- Prefer decision-ready statements over long standards theory.',
	        '- If spreadsheets contain EXCEL_STATS blocks, use maxima/minima; if a limit is not in the excerpts, only mention it as general knowledge (inline label) or state it is not verified here.'
	      ];

    const systemComparison = [
      'If the user asks for comparison or what changed:',
      '- Identify the compared items (documents/versions) from filenames and content.',
      '- Produce a compact comparison table: Item/Aspect, Doc A, Doc B, Difference, Impact/Notes.',
      '- If you cannot uniquely identify A vs B, ask ONE clarifying question at the top, then proceed with best-effort grouping.'
    ];

	    const systemStandardsFor = (l) => (l === 'hu')
	      ? [
	        'Ha a user szabványokat/követelményeket kér:',
	        '- Sorold fel a fájlokban ténylegesen megjelenő szabványokat.',
	        '- Adj rövid checklistet, milyen bizonyíték kell a megfeleléshez.',
	        '- Klauzulaszámot ne találj ki; ha nincs a kivonatban, ne említsd.'
	      ]
	      : [
	        'If the user asks about standards/requirements:',
	        '- List the standards explicitly mentioned in the provided excerpts.',
	        '- Provide a short checklist of what evidence is needed to demonstrate compliance.',
	        '- Do not invent clause numbers; if not in excerpts, do not cite.'
	      ];

	    const systemExec = [
	      'If the user asks for an executive summary:',
	      '- Start with 5 bullet key points.',
	      '- Then a short risk/decision section (3 bullets).',
	      '- Then "Next steps" (5 bullets).',
	      '- Keep it to ~1 page.'
	    ];

	    const systemExecutiveConsultantFor = (l) => (l === 'hu')
	      ? [
	        'Ha a kérdés döntés-előkészítő jellegű vagy a user vezetői tanácsadó szintet vár:',
	        '- Fogalmazz vezetői/konzultáns hangon: döntési opciók, trade-offok, kockázatok, költség/idő/erőforrás hatás, ajánlott irány.',
	        '- Ne írj hosszú módszertani fejtegetést; legyél rövid és akcióorientált.',
	        '- Ha kritikus hiányzó információ van, tegyél fel legfeljebb 1 tisztázó kérdést, majd adj best-effort javaslatot feltételezésekkel.'
	      ]
	      : [
	        'If the question is decision-prep or the user expects executive-consultant level:',
	        '- Use an executive/consultant tone: options, trade-offs, risks, cost/time/resource impact, recommended path.',
	        '- Avoid long methodology; be concise and action-oriented.',
	        '- If a critical input is missing, ask at most 1 clarifying question, then still provide a best-effort recommendation with assumptions.'
	      ];

    const systemHowto = [
      'If the user asks "how" / process:',
      '- Provide a step-by-step description based on the documents.',
      '- If a step is not evidenced, say it is not in the provided excerpts.'
    ];

	    const plannedIntent = (plan?.intent && typeof plan.intent === 'string') ? String(plan.intent) : intent;
	    const plannedLang = lang;
	    const plannedExec = !!plan?.executive;

	    const systemExtras = [];
	    if (plannedIntent === 'nb_audit' || wantsCompliance) systemExtras.push(...systemAuditWebFor(plannedLang));
	    if (plannedIntent === 'comparison' || plannedIntent === 'what_changed') systemExtras.push(...systemComparison);
	    if (plannedIntent === 'standards') systemExtras.push(...systemStandardsFor(plannedLang));
	    if (plannedIntent === 'exec_summary') systemExtras.push(...systemExec);
	    if (plannedIntent === 'howto') systemExtras.push(...systemHowto);
	    if (plannedExec) systemExtras.push(...systemExecutiveConsultantFor(plannedLang));

	    const system = [...systemBase, ...systemExtras].join(' ');

	    const outputLengthHint = (plannedIntent === 'exec_summary')
	      ? (plannedLang === 'hu' ? 'Tartsd ~1 oldal alatt.' : 'Keep it to ~1 page.')
	      : (plannedIntent === 'comparison' || plannedIntent === 'what_changed')
	        ? 'Keep it to a table + short notes.'
	        : (plannedIntent === 'standards')
	          ? 'Keep it to a standards list + checklist + short notes.'
	          : (plannedIntent === 'nb_audit' || wantsCompliance)
	            ? 'Keep it concise and decision-ready (roughly 1–2 pages). Prefer tables + bullets over long prose.'
	            : 'Keep the answer concise; avoid long generic explanations.';

    const userParts = [];
    if (filesInScope.length) {
      userParts.push('Files in scope:\n' + filesInScope.map(n => `- ${safeFilename(n)}`).join('\n'));
    }
    if (evidenceSummaries.length) {
      userParts.push(`EVIDENCE SUMMARIES (auto-extracted per file; may be incomplete):\n\n${evidenceSummaries.join('\n\n')}`);
    }
	    if (contextBlock) {
	      userParts.push(`FILE CONTEXT (top matches):\n\n${contextBlock}`);
	    } else {
	      userParts.push('FILE CONTEXT: (no relevant chunks found)');
	    }
	    if (history) {
	      userParts.push(`Conversation (for continuity; not evidence):\n${history}`);
	    }
	    userParts.push(`USER QUESTION:\n${message}`);
	    userParts.push(outputLengthHint);

	    const messages = [{ role: 'system', content: system }];
	    if (plan && (plan?.structure || plan?.ask_clarifying)) {
	      const planLines = [];
	      if (plan?.structure) planLines.push(`structure=${String(plan.structure).slice(0, 400)}`);
	      if (plan?.length) planLines.push(`length=${String(plan.length).slice(0, 40)}`);
	      if (plan?.executive) planLines.push('executive=true');
	      if (plan?.ask_clarifying && plan?.clarifying_question) {
	        planLines.push(`clarifying_question=${String(plan.clarifying_question).slice(0, 400)}`);
	      }
	      messages.push({
	        role: 'system',
	        content: `INTERNAL FORMAT PLAN (do not mention this plan in the answer):\n${planLines.join('\n')}`
	      });
	    }
	    if (backgroundKbBlock) {
	      messages.push({
	        role: 'system',
	        content:
	          'INTERNAL BACKGROUND KB SNIPPETS (assistant vector store; use silently; do not add a separate section; do not claim these come from uploads):\n\n' +
	          backgroundKbBlock
	      });
	    }
	    messages.push({ role: 'user', content: userParts.join('\n\n') });

    // ---- 5) Stream chat completions ----
    let accText = '';
    let usedModel = completionsPrimary;

    async function runStream(modelName) {
      const streamT0 = Date.now();
      try {
        const stream = await openai.chat.completions.create({
          model: modelName,
          messages,
          stream: true
        });
        for await (const part of stream) {
          const delta = part?.choices?.[0]?.delta?.content || '';
          if (delta) {
            accText += delta;
            send('token', { delta });
          }
        }
      } catch (e) {
        logHttpError(`chat stream failed model=${modelName}`, e);
        throw e;
      } finally {
        logger.info('[CHAT_WITH_FILES_COMPLETIONS] stream finished', { model: modelName, ms: Date.now() - streamT0, outChars: accText.length });
      }
    }

    try {
      send('assistant.status', { stage: 'assistant.start', model: completionsPrimary });
      await runStream(completionsPrimary);
      send('assistant.status', { stage: 'assistant.done', model: completionsPrimary });
    } catch (e) {
      usedModel = completionsFallback;
      send('assistant.status', { stage: 'assistant.fallback', model: completionsFallback, error: e?.message || 'primary failed' });
      await runStream(completionsFallback);
      send('assistant.status', { stage: 'assistant.done', model: completionsFallback });
	    }
	
	    // ---- 5) Persist to Conversation + respond ----
	    let cleaned = (accText || '').replace(/【.*?】/g, '');
	    // Some model outputs start with an explicit short conclusion/header - strip it to match desired web-style.
	    cleaned = cleaned.replace(/^\s*Rövid\s+válasz\s*[:\-–—]\s*/i, '');
	    cleaned = cleaned.replace(/^\s*Rövid\s+válasz\s*\n+/i, '');
	    cleaned = cleaned.replace(/^\s*Rövid\s+összefoglaló\s*[:\-–—]?\s*/i, '');
	    cleaned = cleaned.replace(/^\s*Rövid\s+összefoglaló\s*\n+/i, '');
	    cleaned = cleaned.replace(/^\s*Rövid\s+összegzés\s*[:\-–—]?\s*/i, '');
	    cleaned = cleaned.replace(/^\s*Rövid\s+összegzés\s*\n+/i, '');
	    cleaned = cleaned.replace(/^\s*Short\s+conclusion\s*[:\-–—]?\s*/i, '');
	    cleaned = cleaned.replace(/^\s*Short\s+conclusion\s*\n+/i, '');
	    const sanitized = sanitizeHtml(cleaned, {
	      allowedTags: ['a', 'b', 'i', 'strong', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
	      allowedAttributes: { 'span': ['class'], 'a': ['href', 'title', 'target', 'rel'] },
      transformTags: {
        'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true)
      },
      disallowedTagsMode: 'discard'
    });
	    const finalHtml = marked(sanitized);
	
	    conversation.messages.push({
	      role: 'user',
	      content: message,
	      meta: {
	        kind: 'chat-with-files-completions',
	        mode,
	        model: usedModel,
	        uploads: nowFiles,
	        retrieval: {
	          strategy: embeddingsEnabled ? 'embeddings' : 'keyword',
	          reason: embeddingsDisabledReason || null
	        }
	      }
	    });
    conversation.messages.push({ role: 'assistant', content: finalHtml, images: [] });
    await conversation.save();
    const savedAssistant = conversation.messages.slice().reverse().find(m => m.role === 'assistant');

    send('final', { html: finalHtml, messageId: savedAssistant?._id || null });
    send('done', { ok: true });
    logger.info('[CHAT_WITH_FILES_COMPLETIONS] done', {
      threadId,
      mode,
      model: usedModel,
      uploads: uploads.length,
      outChars: accText.length,
      msTotal: Date.now() - t0
    });
    return res.end();

  } catch (e) {
    try {
      logger.error('[CHAT_WITH_FILES_COMPLETIONS] hiba', {
        message: e?.message,
        stack: e?.stack,
        name: e?.name,
        type: typeof e,
        keys: e && typeof e === 'object' ? Object.keys(e) : null
      });
    } catch {
      logger.error('[CHAT_WITH_FILES_COMPLETIONS] hiba:', e?.message);
    }
    send('error', { message: e?.message || 'Váratlan hiba történt.' });
    send('done', { ok: false });
    return res.end();
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
  "építési hely meghatározás": ["KESZ_7_MELL-7.png"],
  "utcai párkánymagasság": ["KESZ_7_MELL-15.png"],
  "magassági idom": ["KESZ_7_MELL-18.png"],
  "Az építési övezetek magassági szabályozása": ["KESZ_4_MELL_MAGASSAG.png"],
  "XIII kerület magassági szabályozás": ["KESZ_4_MELL_MAGASSAG.png"],
  "épületmagasság": ["KESZ_4_MELL_MAGASSAG.png"],
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
        } catch (_) { }
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
// ===== Delete conversation + cleanup Hybrid/Sandbox resources =====
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
    const headers = (extra = {}) => ({
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'assistants=v2',
      ...extra
    });

    async function getAssistantVectorStoreId(assistantId) {
      if (!assistantId) return null;
      try {
        const r = await axios.get(
          `https://api.openai.com/v1/assistants/${assistantId}`,
          { headers: headers() }
        );
        const ids = r.data?.tool_resources?.file_search?.vector_store_ids || [];
        return ids[0] || null;
      } catch (e) {
        logger.warn('[DELETE][CLEANUP] getAssistantVectorStoreId failed:', e?.response?.data || e?.message);
        return null;
      }
    }

    const safeDelete = async (fn) => {
      try { await fn(); }
      catch (e) { logger.warn('[DELETE][CLEANUP]', e?.response?.data || e?.message); }
    };

    // Determine mode and inputs
    const mode = conversation.mode || (conversation.vectorStoreId ? 'sandbox' : 'default');
    const fileIds = Array.isArray(conversation.fileIds) ? conversation.fileIds.filter(Boolean) : [];

    if (mode === 'sandbox') {
      // 1) Delete entire vector store (if any)
      if (conversation.vectorStoreId) {
        await safeDelete(() =>
          axios.delete(`https://api.openai.com/v1/vector_stores/${conversation.vectorStoreId}`, { headers: headers() })
        );
      }
      // 2) Delete the dedicated sandbox assistant (if persisted)
      if (conversation.assistantId) {
        await safeDelete(() =>
          axios.delete(`https://api.openai.com/v1/assistants/${conversation.assistantId}`, { headers: headers() })
        );
      }
      // 3) Delete uploaded File objects (best-effort)
      for (const fid of fileIds) {
        await safeDelete(() =>
          axios.delete(`https://api.openai.com/v1/files/${fid}`, { headers: headers() })
        );
      }
    } else if (mode === 'hybrid') {
      // Hybrid → remove files from the shared vector store, then (optionally) delete File objects
      let vectorStoreId = conversation.vectorStoreId || null;
      if (!vectorStoreId) {
        // Resolve assistant to get its default store
        let assistantId = conversation.assistantId;
        if (!assistantId) {
          // fallback to tenant default assistant
          const tenant = await Tenant.findById(tenantId).select('name');
          const tenantKey = String(tenant?.name || '').toLowerCase();
          assistantId = assistants.byTenant?.[tenantKey] || assistants['default'];
        }
        vectorStoreId = await getAssistantVectorStoreId(assistantId);
      }

      if (vectorStoreId && fileIds.length) {
        for (const fid of fileIds) {
          // 1) Detach from store (ignore 404/409)
          await safeDelete(() =>
            axios.delete(
              `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${fid}`,
              { headers: headers() }
            )
          );
          // 2) (optional) delete the File object itself
          await safeDelete(() =>
            axios.delete(`https://api.openai.com/v1/files/${fid}`, { headers: headers() })
          );
        }
      }
    }

    // Optional: delete the OpenAI thread itself (best-effort)
    await safeDelete(() =>
      axios.delete(`https://api.openai.com/v1/threads/${threadId}`, { headers: headers() })
    );

    // Local RAG cleanup (best-effort): remove stored chunks for this thread
    await (async () => {
      try { await RagChunk.deleteMany({ threadId, tenantId }); }
      catch (e) { logger.warn('[DELETE][CLEANUP] RagChunk deleteMany failed:', e?.message); }
    })();

    // Finally, remove conversation from DB
    await Conversation.deleteOne({ threadId, userId, tenantId });

    return res.json({
      ok: true,
      threadId,
      cleaned: {
        mode,
        files: fileIds.length,
        vectorStoreDeleted: mode === 'sandbox' && !!conversation.vectorStoreId
      }
    });
  } catch (e) {
    logger.error('[DELETE][CONVERSATION] hiba:', e?.message);
    return res.status(500).json({ error: 'Törlés közben hiba történt.' });
  }
};
