const axios = require('axios');
const FormData = require('form-data');
const sanitizeHtml = require('sanitize-html');
const OpenAI = require('openai');
const { get_encoding } = require('tiktoken');
const http = require('http');
const https = require('https');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { initSse } = require('../services/sseService');
const { buildTabularHint } = require('../services/chatPromptService');
const { resolveUserAndTenant, ensureConversationOwnership } = require('../services/chatAccessService');

const encoder = get_encoding('o200k_base');

const axiosClient = axios.create({
  timeout: 300000, // 5 minutes
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

// In-memory concurrency guard for uploadAndAskStream
const activeAskThreads = new Set();

async function handleUploadAndAskStream(req, res) {
  const send = initSse(req, res);

    let conversation; // visible in catch
    let threadId;
    try {
      let userId = req.userId;
      let tenantId = req.scope?.tenantId || undefined;
      const files = req.files || [];
      // Read question in new flexible way
      const { threadId: tid, question: rawQuestion, userQuestion } = req.body || {};
      threadId = tid;
      const question = (typeof userQuestion === 'string' && userQuestion.trim()) ? userQuestion : (typeof rawQuestion === 'string' ? rawQuestion : '');
      const reduceTabularHint = buildTabularHint(question);

      try {
        const resolved = await resolveUserAndTenant(req);
        userId = resolved.userId;
        tenantId = resolved.tenantId;
      } catch (e) {
        send('error', { message: e?.message || 'Hiányzó vagy érvénytelen JWT.' });
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
        try {
          conversation = await ensureConversationOwnership({ threadId, userId, tenantId });
        } catch (e) {
          send('error', { message: e?.message || 'A beszélgetés nem található vagy nem hozzáférhető.' });
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
        const HARD_INPUT_CAP = Math.max(
          80_000,
          parseInt(String(systemSettings.getNumber('UPLOAD_ASK_INPUT_CAP') || 120000), 10)
        ); // per reduce round
        const MAP_CHUNK_SIZE = Math.max(
          1500,
          parseInt(String(systemSettings.getNumber('QA_CHUNK_TOKENS') || 3000), 10)
        ); // per-map chunk input tokens
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

        const modelPrimary = systemSettings.getString('SUMMARY_COMPLETIONS_MODEL') || 'gpt-5-mini';
        const modelFallback = systemSettings.getString('SUMMARY_COMPLETIONS_FALLBACK') || 'gpt-4o-mini';

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
              const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');
              const sys = String(messages?.find(m => m && m.role === 'system')?.content || '');
              const usr = String(messages?.find(m => m && m.role === 'user')?.content || '');

              const respObj = await createResponse({
                model: modelName,
                instructions: sys,
                input: [{ role: 'user', content: usr }],
                store: false,
                temperature: 0,
                maxOutputTokens: 1800,
                timeoutMs: 120_000,
              });
              return extractOutputTextFromResponse(respObj) || '';
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

module.exports = { handleUploadAndAskStream };
