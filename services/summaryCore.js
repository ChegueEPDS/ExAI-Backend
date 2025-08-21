// services/summaryCore.js
const axios = require('axios');
const http = require('http');
const https = require('https');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const FormData = require('form-data');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const tiktoken = require('tiktoken');

const encoder = tiktoken.get_encoding('o200k_base');

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

const axiosClient = axios.create({
  timeout: 300000,
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

function parseRetryAfterSeconds(msg) {
  if (!msg) return null;
  const m = msg.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (m) {
    const s = parseFloat(m[1]);
    if (!isNaN(s)) return Math.ceil(s * 1000);
  }
  return null;
}

async function runAssistantOnce({ threadId, assistantId, promptText, label, openaiApiKey, emit }) {
  let attempt = 0;
  const RATE_LIMIT_MAX_RETRIES = 5;

  while (true) {
    attempt++;
    try {
      await axiosClient.post(
        `https://api.openai.com/v1/threads/${threadId}/messages`,
        { role: 'user', content: promptText },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openaiApiKey}`,
            'OpenAI-Beta': 'assistants=v2',
          }
        }
      );

      // If there's an active run, wait it out
      try {
        const runsList = await axiosClient.get(`https://api.openai.com/v1/threads/${threadId}/runs`, {
          headers: { Authorization: `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' },
        });
        const active = runsList.data?.data?.find(r => ['queued','in_progress','requires_action','cancelling'].includes(r.status));
        if (active) {
          emit('progress', { stage: 'assistant.wait_active_run', label, runId: active.id, status: active.status });
          let triesWait = 0;
          while (['queued','in_progress','requires_action','cancelling'].includes(active.status) && triesWait < 120) {
            await new Promise(r => setTimeout(r, 1000));
            triesWait++;
            const r2 = await axiosClient.get(`https://api.openai.com/v1/threads/${threadId}/runs/${active.id}`, {
              headers: { Authorization: `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' },
            });
            if (!['queued','in_progress','requires_action','cancelling'].includes(r2.data.status)) break;
            emit('progress', { stage: 'assistant.wait_active_run', label, runId: active.id, status: r2.data.status, tick: triesWait });
          }
        }
      } catch (e) {
        emit('error', { stage: 'assistant.active_run_check_failed', label, error: e.message });
      }

      const runResp = await axiosClient.post(
        `https://api.openai.com/v1/threads/${threadId}/runs`,
        { assistant_id: assistantId },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openaiApiKey}`,
            'OpenAI-Beta': 'assistants=v2',
          }
        }
      );

      let tries = 0;
      const maxTries = 300;
      while (tries < maxTries) {
        await new Promise(r => setTimeout(r, 500));
        tries++;

        const statusResponse = await axiosClient.get(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runResp.data.id}`,
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' } }
        );

        const status = statusResponse.data.status;
        emit('progress', { stage: 'assistant.status', label, status, tick: tries });
        if (status === 'completed') break;
        if (['failed','cancelled','expired'].includes(status)) {
          const runDetailResp = await axiosClient.get(
            `https://api.openai.com/v1/threads/${threadId}/runs/${runResp.data.id}`,
            { headers: { Authorization: `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' } }
          );
          const lastError = runDetailResp?.data?.last_error || runDetailResp?.data?.incomplete_details || null;
          if (lastError && (lastError.code === 'rate_limit_exceeded' || lastError.code === 'insufficient_quota')) {
            const msg = lastError?.message || '';
            const err = new Error(msg);
            err.__rate_limit__ = true;
            err.__last_error__ = lastError;
            throw err;
          }
          throw new Error(`Run failed: ${status}${lastError ? ' - ' + JSON.stringify(lastError) : ''}`);
        }
      }

      const messagesResponse = await axiosClient.get(
        `https://api.openai.com/v1/threads/${threadId}/messages`,
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' } }
      );

      const assistantMessage = messagesResponse.data.data.find(m => m.role === 'assistant');
      let text = '';
      if (assistantMessage) {
        if (Array.isArray(assistantMessage.content)) {
          assistantMessage.content.forEach(item => {
            if (item.type === 'text' && item.text && item.text.value) text += item.text.value;
          });
        } else {
          text = assistantMessage.content || '';
        }
      } else {
        emit('error', { stage: 'assistant.no_message', label });
      }

      return text;

    } catch (err) {
      const isRateLimit = err?.__rate_limit__ || err?.response?.status === 429 || /rate limit/i.test(err?.message || '');
      if (isRateLimit && attempt < RATE_LIMIT_MAX_RETRIES) {
        const hintedMs = parseRetryAfterSeconds(err.message) || 10000 * attempt;
        emit('progress', { stage: 'rate_limit', attempt, waitMs: hintedMs, label, message: err.message });
        await new Promise(r => setTimeout(r, hintedMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Fő folyamat: feltöltött fájlok kinyerése -> token-chunkolás -> map/reduce összefoglalás -> HTML
 * @param {{files: Array, threadId: string, assistantId: string, baseUrl: string, openaiApiKey: string}} ctx
 * @param {{emit: (event, payload)=>void, patch: (patchObj)=>Promise<void>}} hooks
 * @returns {{finalHtml: string, messageId: string|null}}
 */
async function runUploadAndSummarize(ctx, hooks) {
  const { files, threadId, assistantId, baseUrl, openaiApiKey } = ctx;
  const { emit, patch } = hooks;

  // 1) Kinyerés
  const extracted = [];
  for (const f of files) {
    emit('progress', { stage: 'file.read', file: f.originalname, size: f.size, mimetype: f.mimetype });

    let text = '';
    const mt = (f.mimetype || '').toLowerCase();
    try {
      if (mt === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf')) {
        const form = new FormData();
        form.append('file', f.buffer, { filename: f.originalname, contentType: f.mimetype || 'application/pdf' });
        form.append('certType', 'ATEX');
        const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, {
          headers: form.getHeaders(),
          timeout: 300000,
        });
        text = (resp.data?.recognizedText || '').toString();
      } else if (mt.startsWith('image/')) {
        const form = new FormData();
        form.append('image', f.buffer, { filename: f.originalname, contentType: f.mimetype || 'application/octet-stream' });
        const uploadResp = await axiosClient.post(`${baseUrl}/api/vision/upload`, form, {
          headers: form.getHeaders(),
          timeout: 300000,
        });
        const imageUrl = uploadResp.data?.image_url;
        if (!imageUrl) throw new Error('Vision upload nem adott vissza image_url-t.');

        const analyzeResp = await axiosClient.post(`${baseUrl}/api/vision/analyze`, {
          image_urls: [imageUrl],
          user_input: 'Please describe in English the key information present in the image, including visible text/labels and relevant context.'
        }, { timeout: 300000, headers: { 'Content-Type': 'application/json' } });

        text = (analyzeResp.data?.result || '').toString();
      } else if (mt.includes('wordprocessingml') || f.originalname.toLowerCase().endsWith('.docx')) {
        const out = await mammoth.extractRawText({ buffer: f.buffer });
        text = out.value || '';
      } else if (mt.includes('msword') || f.originalname.toLowerCase().endsWith('.doc')) {
        try { text = f.buffer.toString('utf8'); } catch { text = ''; }
      } else if (
        mt.includes('excel') ||
        mt.includes('spreadsheetml') ||
        f.originalname.toLowerCase().endsWith('.xls') ||
        f.originalname.toLowerCase().endsWith('.xlsx')
      ) {
        const wb = xlsx.read(f.buffer, { type: 'buffer' });
        const parts = [];
        wb.SheetNames.forEach(sheet => {
          const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false });
          parts.push(`-- SHEET: ${sheet} --\n${csv}`);
        });
        text = parts.join('\n\n');
      } else if (mt === 'text/plain' || f.originalname.toLowerCase().endsWith('.txt')) {
        text = f.buffer.toString('utf8');
      } else {
        try { text = f.buffer.toString('utf8'); } catch { text = ''; }
      }
    } catch (e) {
      emit('error', { stage: 'extract', file: f.originalname, message: e.message });
      text = '';
    }

    extracted.push({ name: f.originalname, mimetype: f.mimetype, content: (text || '').trim() });
    emit('progress', { stage: 'file.done', file: f.originalname, chars: (text || '').length });
    await patch({
      stage: 'file.done',
      progress: {
        filesProcessed: undefined, // a controller tartja számon – itt csak a lastMessage jó
        lastMessage: `Parsed: ${f.originalname}`
      }
    });
  }

  emit('progress', { stage: 'files.done', count: extracted.length });
  await patch({
    stage: 'files.done',
    meta: { totalChars: extracted.reduce((a, b) => a + (b.content?.length || 0), 0) }
  });

  // 2) Map-Reduce
  const FILE_CHUNK_TOKENS = 2800;
  const TOKEN_BUDGET_PER_MIN = 190000;
  let budgetWindowStart = Date.now();
  let budgetSpent = 0;

  async function throttleForBudget(needTokens, label) {
    const now = Date.now();
    if (now - budgetWindowStart >= 60_000) {
      budgetWindowStart = now;
      budgetSpent = 0;
    }
    if (budgetSpent + needTokens > TOKEN_BUDGET_PER_MIN) {
      const waitMs = 60_000 - (now - budgetWindowStart);
      if (waitMs > 0) {
        emit('progress', { stage: 'budget.wait', label, waitMs, spent: budgetSpent, need: needTokens, budget: TOKEN_BUDGET_PER_MIN });
        await new Promise(r => setTimeout(r, waitMs));
        budgetWindowStart = Date.now();
        budgetSpent = 0;
      }
    }
    budgetSpent += needTokens;
    emit('progress', { stage: 'tokens.charge', label, needTokens, budgetSpent, budget: TOKEN_BUDGET_PER_MIN });
    await patch({
      stage: 'tokens.charge',
      progress: {
        tokensUsed: budgetSpent,
        tokenBudget: TOKEN_BUDGET_PER_MIN,
        lastMessage: `Token budget used: ${budgetSpent}/${TOKEN_BUDGET_PER_MIN}`
      }
    });
  }

  emit('progress', {
    stage: 'combined.start',
    files: extracted.length,
    totalChars: extracted.reduce((a, b) => a + (b.content?.length || 0), 0)
  });

  const combinedHeader = extracted.map(x => x.name).join(', ');
  const combinedCorpus = extracted.map(x => `### ${x.name}\n${x.content || ''}`).join('\n\n---\n\n');
  const corpusChunks = chunkByTokens(combinedCorpus, FILE_CHUNK_TOKENS);

  // === Optional stronger mode: push the FULL corpus into the thread as multiple user messages,
  // then ask for one final summary. This avoids map->reduce compression bias.
  // Enable with: SUMMARY_THREAD_SPLIT=1
  // Optional: SUMMARY_THREAD_PART_TOKENS (default 6000) – approx token size per part
  {
    const USE_THREAD_SPLIT = String(process.env.SUMMARY_THREAD_SPLIT || '0') === '1';
    if (USE_THREAD_SPLIT) {
      const PART_TOKENS = Math.max(1000, parseInt(process.env.SUMMARY_THREAD_PART_TOKENS || '6000', 10) || 6000);

      const parts = chunkByTokens(combinedCorpus, PART_TOKENS);
      emit('progress', { stage: 'thread_split.start', parts: parts.length, partTokens: PART_TOKENS });

      // 1) Push each part as its own user message (no run yet)
      for (let i = 0; i < parts.length; i++) {
        const label = `thread-split part ${i + 1}/${parts.length}`;
        emit('progress', { stage: 'thread_split.post_part', index: i + 1, total: parts.length });
        const content = [
          `Document Part ${i + 1} / ${parts.length}`,
          '',
          parts[i]
        ].join('\n');

        await axiosClient.post(
          `https://api.openai.com/v1/threads/${threadId}/messages`,
          { role: 'user', content },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiApiKey}`,
              'OpenAI-Beta': 'assistants=v2',
            }
          }
        );
      }

      // 2) Final instruction asking to summarize EVERYTHING in the thread
      const finalPrompt = [
        `You have received the project documentation above in multiple parts (as consecutive user messages).`,
        `Produce ONE comprehensive final summary in English using the following structure:`,
        `1) Table of Contents (just a list of file names)`,
        `2) Key Findings (bullet points, include concrete numbers/units when available)`,
        `3) Decision Points and Options`,
        `4) Deadlines and Next Steps (responsible + proposed timeline, if available; otherwise "n/a")`,
        `5) Risks and Open Questions`,
        '',
        `Finish with an Executive Summary. Always use the relevant documents and standards in your knowledge base for the summary!`,
        '',
        `Processed files: ${combinedHeader}`
      ].join('\n');

      // We reuse runAssistantOnce to launch a single run after the parts are in the thread
      const estTok = estimateTokens(finalPrompt, 1.8);
      emit('progress', { stage: 'tokens.estimate', label: 'thread-split.final', estTok });
      await throttleForBudget(estTok, 'thread-split.final');

      const finalText = await runAssistantOnce({
        threadId,
        assistantId,
        promptText: finalPrompt,
        label: 'thread-split.final',
        openaiApiKey,
        emit
      });

      // Clean + HTML
      let cleaned = (finalText || '').replace(/【.*?】/g, '');
      const sanitized = sanitizeHtml(cleaned, {
        allowedTags: ['b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6'],
        allowedAttributes: { 'span': ['class'] },
        disallowedTagsMode: 'discard'
      });
      const finalHtml = marked(sanitized);

      // Early return – we used the thread-split path, no map-reduce needed
      return { finalHtml, messageId: null };
    }
  }

  emit('progress', { stage: 'combined.chunks', count: corpusChunks.length, chunkTokenLimit: FILE_CHUNK_TOKENS });
  await patch({ stage: 'combined.chunks', progress: { chunksTotal: corpusChunks.length } });

  const chunkSummaries = [];
  for (let i = 0; i < corpusChunks.length; i++) {
    const label = `chunk ${i + 1}/${corpusChunks.length} (combined)`;
    emit('progress', { stage: 'combined.chunk', index: i + 1, total: corpusChunks.length });
    await patch({
      stage: 'combined.chunk',
      progress: {
        chunksCompleted: i,
        lastMessage: `Sending combined chunk ${i + 1}/${corpusChunks.length}`
      }
    });

    const chunkPrompt = [
      `You will receive a fragment of the overall project documentation. The related filenames appear as section headers (### FILENAME).`,
      `Task: Summarize this fragment in 6–10 concise bullet points in English.`,
      `Requirements:`,
      `- Extract and list only concrete facts mentioned, including numbers and units (mm, °C, V, etc.) when present.`,
      `- Do not guess or generalize. If a detail is missing, write "n/a".`,
      `- Be precise and avoid repetition.`,
      ``,
      `Fragment:`,
      corpusChunks[i]
    ].join('\n\n');

    const estTok = estimateTokens(chunkPrompt);
    emit('progress', { stage: 'tokens.estimate', label, estTok });
    await throttleForBudget(estTok, label);

    const partial = await runAssistantOnce({
      threadId, assistantId, promptText: chunkPrompt, label, openaiApiKey, emit
    });
    chunkSummaries.push((partial || '').trim());
  }

  emit('progress', { stage: 'combined.reduce.start', parts: chunkSummaries.length });

  const reducePrompt = [
    `You will receive several partial summaries of a shared project documentation set (multiple files).`,
    `Produce ONE comprehensive final summary in English using the following structure:`,
    `1) Table of Contents (just a list of file names)`,
    `2) Key Findings (bullet points, include concrete numbers/units when available)`,
    `3) Decision Points and Options`,
    `4) Deadlines and Next Steps (responsible + proposed timeline, if available; otherwise "n/a")`,
    `5) Risks and Open Questions`,
    ``,
    `Finish with an Executive Summary. Allways use the relevant documents and standards in your knowledge base for the summary!`,
    ``,
    `Processed files: ${combinedHeader}`,
    ``,
    `Partial summaries:`,
    chunkSummaries.join('\n\n')
  ].join('\n\n');

  {
    const estTok = estimateTokens(reducePrompt, 1.8);
    emit('progress', { stage: 'tokens.estimate', label: 'final-synthesis', estTok });
    await throttleForBudget(estTok, 'final-synthesis');
    var finalText = await runAssistantOnce({
      threadId, assistantId, promptText: reducePrompt, label: 'final-synthesis', openaiApiKey, emit
    });
  }

  // Clean + HTML
  let cleaned = (finalText || '').replace(/【.*?】/g, '');
  const sanitized = sanitizeHtml(cleaned, {
    allowedTags: ['b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6'],
    allowedAttributes: { 'span': ['class'] },
    disallowedTagsMode: 'discard'
  });
  const finalHtml = marked(sanitized);

  return { finalHtml, messageId: null };
}

module.exports = { runUploadAndSummarize };