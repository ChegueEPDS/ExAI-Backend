// services/qaCore.js
const crypto = require('crypto');
const FormData = require('form-data');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const tiktoken = require('tiktoken');
const axios = require('axios');
const http = require('http');
const https = require('https');

/**
 * This version enforces chunked map-reduce for large contexts to avoid 400/413
 * and implements strong 429 backoff with jitter + global concurrency control.
 */
const QA_CORE_VERSION = '2.1-chunked';

// Models (re-use SUMMARY_* envs for consistency with summaryCore)
const DEFAULT_COMPLETIONS_MODEL = process.env.SUMMARY_COMPLETIONS_MODEL || 'gpt-5-mini';
const COMPLETIONS_FALLBACK_MODEL = process.env.SUMMARY_COMPLETIONS_FALLBACK || 'gpt-4o-mini';

// --- Global concurrency guard to reduce 429 bursts ---
const MAX_PARALLEL_OPENAI = parseInt(process.env.OPENAI_PARALLEL || '2', 10);
let _openaiInFlight = 0;
const _openaiQueue = [];
async function withOpenAISlot(fn) {
  if (_openaiInFlight >= MAX_PARALLEL_OPENAI) {
    await new Promise(res => _openaiQueue.push(res));
  }
  _openaiInFlight++;
  try {
    return await fn();
  } finally {
    _openaiInFlight--;
    const next = _openaiQueue.shift();
    if (next) next();
  }
}
function jitter(ms) {
  // ±20% jitter
  const d = Math.floor(ms * 0.2);
  return ms - d + Math.floor(Math.random() * (2 * d + 1));
}

const encoder = tiktoken.get_encoding('o200k_base');
const axiosClient = axios.create({
  timeout: 300000,
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50 }),
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  // explicit: let OpenAI handle compression; avoid proxy-level surprises
  decompress: true
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseRetryAfter(resp) {
  const h = resp?.headers?.['retry-after'];
  if (!h) return null;
  const s = parseFloat(h);
  return isNaN(s) ? null : Math.max(1000, Math.round(s * 1000));
}

// --- Tiny in-memory LRU for extracted texts (hash -> text) ---
const LRU = new Map();
const LRU_MAX = 100;
function lruSet(k, v) {
  if (LRU.has(k)) LRU.delete(k);
  LRU.set(k, v);
  if (LRU.size > LRU_MAX) {
    const first = LRU.keys().next().value;
    LRU.delete(first);
  }
}

function tokLen(s = '') { return encoder.encode(String(s)).length; }
function trimToTokens(text, maxTokens) {
  const ids = encoder.encode(text || '');
  return encoder.decode(ids.slice(0, maxTokens));
}

/**
 * Extract text from various file types:
 * - PDF → your /api/pdfcert OCR
 * - images → /api/vision/upload + /api/vision/analyze
 * - docx/doc → mammoth / utf8 fallback
 * - xls/xlsx → CSV per sheet
 * - txt/others → utf8 fallback
 */
async function extractFileToText(file, baseUrl) {
  const mt = (file.mimetype || '').toLowerCase();
  try {
    const hash = crypto.createHash('sha256')
      .update(file.buffer)
      .update(mt)
      .update(file.originalname || '')
      .digest('hex');

    const cached = LRU.get(hash);
    if (cached) return cached;

    if (mt === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      const form = new FormData();
      form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype || 'application/pdf' });
      form.append('certType', 'ATEX');
      const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, { headers: form.getHeaders(), timeout: 300000 });
      const out = String(resp.data?.recognizedText || '');
      lruSet(hash, out);
      return out;
    }
    if (mt.startsWith('image/')) {
      const form = new FormData();
      form.append('image', file.buffer, { filename: file.originalname, contentType: file.mimetype || 'application/octet-stream' });
      const upload = await axiosClient.post(`${baseUrl}/api/vision/upload`, form, { headers: form.getHeaders(), timeout: 300000 });
      const imageUrl = upload.data?.image_url;
      if (!imageUrl) return '';
      const analyze = await axiosClient.post(`${baseUrl}/api/vision/analyze`, {
        image_urls: [imageUrl],
        user_input: 'Extract all readable text and labels. If tables appear, describe them row-wise.'
      }, { timeout: 300000, headers: { 'Content-Type': 'application/json' } });
      const out = String(analyze.data?.result || '');
      lruSet(hash, out);
      return out;
    }
    if (mt.includes('wordprocessingml') || file.originalname.toLowerCase().endsWith('.docx')) {
      const outRaw = await mammoth.extractRawText({ buffer: file.buffer });
      const out = outRaw.value || '';
      lruSet(hash, out);
      return out;
    }
    if (mt.includes('msword') || file.originalname.toLowerCase().endsWith('.doc')) {
      try { const out = file.buffer.toString('utf8'); lruSet(hash, out); return out; } catch { return ''; }
    }
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
      const out = parts.join('\n\n');
      lruSet(hash, out);
      return out;
    }
    if (mt === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
      const out = file.buffer.toString('utf8');
      lruSet(hash, out);
      return out;
    }

    // Fallback
    const out = file.buffer.toString('utf8');
    lruSet(hash, out);
    return out;
  } catch {
    return '';
  }
}

// --- OpenAI chat helpers with concurrency + retry + SSE-progress ---
async function chatComplete({ model, messages, openaiApiKey }) {
  const modelName = String(model || '').trim();
  const payload = { model: modelName, messages };
  return await withOpenAISlot(async () => {
    const resp = await axiosClient.post(
      'https://api.openai.com/v1/chat/completions',
      payload,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` } }
    );
    return resp.data?.choices?.[0]?.message?.content || '';
  });
}

async function chatCompleteWithRetry({ model, messages, openaiApiKey, tries = 6, hooks }) {
  let attempt = 0;
  let lastErr;
  while (attempt < tries) {
    attempt++;
    try {
      return await chatComplete({ model, messages, openaiApiKey });
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      // Jelentsünk a kliensnek
      if (hooks && typeof hooks.emit === 'function') {
        if (status && status !== 429 && !(status >= 500 && status < 600)) {
          hooks.emit('assistant.status', { stage: 'assistant.primary.fail', model, error: `Request failed with status ${status}` });
        }
      }
      if (!retriable) break;

      // Backoff számítás
      const hinted = parseRetryAfter(err?.response);
      let delay = hinted ?? (1500 * Math.pow(2, attempt - 1)); // 1.5s, 3s, 6s, 12s, ...
      delay = Math.min(delay, 30000);
      delay = jitter(delay);

      if (hooks && typeof hooks.emit === 'function') {
        hooks.emit('assistant.status', { stage: 'assistant.retry', attempt, waitMs: delay, status });
        // plusz: általános "budget.wait"
        hooks.emit('progress', { stage: 'budget.wait', seconds: Math.ceil(delay / 1000), attempt, status });
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function chatCompleteWithFallback({ messages, openaiApiKey, hooks }) {
  try {
    return await chatCompleteWithRetry({
      model: DEFAULT_COMPLETIONS_MODEL,
      messages,
      openaiApiKey,
      tries: 6,
      hooks
    });
  } catch (err) {
    if (hooks && typeof hooks.emit === 'function') {
      hooks.emit('assistant.status', { stage: 'assistant.primary.fail', model: DEFAULT_COMPLETIONS_MODEL, error: err?.message || 'primary model failed' });
    }
    return await chatCompleteWithRetry({
      model: COMPLETIONS_FALLBACK_MODEL,
      messages,
      openaiApiKey,
      tries: 6,
      hooks
    });
  }
}

// --- Chunking helpers ---
function splitIntoTokenChunks(text, maxTokensPerChunk) {
  const ids = encoder.encode(String(text || ''));
  const chunks = [];
  for (let i = 0; i < ids.length; i += maxTokensPerChunk) {
    const slice = ids.slice(i, Math.min(i + maxTokensPerChunk, ids.length));
    chunks.push(encoder.decode(slice));
  }
  return chunks;
}

async function answerChunk({ question, filename, chunkText, openaiApiKey, hooks }) {
  const system = [
    'You are a precise technical assistant.',
    'Answer ONLY using the provided CHUNK below.',
    'If the answer is not present, say "Not found in this chunk."',
    'Cite the most relevant lines from the chunk and include the filename.'
  ].join(' ');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `FILENAME: ${filename}\n\nCHUNK:\n${chunkText}` },
    { role: 'user', content: `QUESTION:\n${question}` }
  ];

  const text = await chatCompleteWithFallback({ messages, openaiApiKey, hooks });
  return String(text || '').trim();
}

async function aggregateAnswers({ question, findings, openaiApiKey, hooks }) {
  const system = [
    'You are a precise technical assistant.',
    'Synthesize the FINAL answer strictly from the provided findings.',
    'Consolidate duplicates, resolve conflicts conservatively.',
    'If evidence is missing, explicitly state: "Not found in provided files."',
    'Always cite the source filename(s) mentioned inside the findings.'
  ].join(' ');

  let findingsPack = findings.join('\n\n---\n\n');
  const MAX_FINDINGS_TOKENS = 60000; // safety cap for aggregator
  if (tokLen(findingsPack) > MAX_FINDINGS_TOKENS) {
    findingsPack = trimToTokens(findingsPack, MAX_FINDINGS_TOKENS);
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `FINDINGS FROM CHUNKS:\n${findingsPack}` },
    { role: 'user', content: `QUESTION:\n${question}\n\nWrite a clear, well-structured answer with brief quotes and a bullet list of the cited filenames.` }
  ];

  const text = await chatCompleteWithFallback({ messages, openaiApiKey, hooks });
  return String(text || '').trim();
}

/**
 * Main entry
 *  - never sends an oversized single-shot prompt;
 *  - auto-chunks files if combined context exceeds SMALL_SHOT_LIMIT;
 *  - emits rich progress events compatible with your SSE UI.
 */
async function runUploadAndAskFullContent({ files, question, baseUrl, openaiApiKey, tokenBudgetPrompt = 120000 }, hooks) {
  const emit = (hooks && typeof hooks.emit === 'function') ? hooks.emit : () => {};
  emit('info', { stage: 'start', message: 'Olvasás/kinyerés indul.' });

  const safeFiles = (files || []).slice(0, 10);

  // 1) Extract text per file
  const parts = [];
  let totalChars = 0;

  emit('progress', { stage: 'files.read', count: safeFiles.length });
  for (const f of safeFiles) {
    emit('progress', { stage: 'file.read', file: f.originalname });
    const txt = await extractFileToText(f, baseUrl);
    const cleaned = (txt || '').replace(/\u0000/g, '');
    parts.push({ filename: f.originalname, text: cleaned });
    totalChars += cleaned.length;
    emit('progress', { stage: 'file.done', file: f.originalname, chars: cleaned.length });
  }
  emit('progress', { stage: 'files.done', count: parts.length, totalChars });

  // 2) Decide path: single-shot for small contexts, otherwise chunked
  const header = `You will answer based ONLY on the following documents. Cite exact passages when possible.\n\n`;
  const combinedBody = parts.map(p => `### ${p.filename}\n${p.text}`).join('\n\n---\n\n');
  let combined = header + combinedBody;

  // Hard safeguard: never allow a true mega single-shot.
  const CONTEXT_BUDGET = tokenBudgetPrompt;         // caller's upper bound (e.g. 120k)
  const SMALL_SHOT_LIMIT = 60000;                   // internal safer limit for qa
  const CAN_SINGLE_SHOT = tokLen(combined) <= Math.min(CONTEXT_BUDGET, SMALL_SHOT_LIMIT);

  if (CAN_SINGLE_SHOT) {
    emit('progress', { stage: 'context.ok', tokens: tokLen(combined), budget: Math.min(CONTEXT_BUDGET, SMALL_SHOT_LIMIT) });

    const system = [
      'You are a precise technical assistant.',
      'Answer ONLY using the provided context below.',
      'If the answer is not present, say "Not found in provided files."',
      'Quote the relevant lines succinctly and list the source filename(s).',
    ].join(' ');

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Context:\n\n${combined}` },
      { role: 'user', content: `Question:\n${question}` }
    ];

    emit('assistant.status', { stage: 'assistant.start' });
    const text = await chatCompleteWithFallback({ messages, openaiApiKey, hooks: { emit } });
    emit('assistant.status', { stage: 'assistant.done' });

    const cleaned = String(text || '').trim();
    const html = marked(sanitizeHtml(cleaned, {
      allowedTags: ['b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6'],
      allowedAttributes: { 'span': ['class'] },
      disallowedTagsMode: 'discard'
    }));
    return { text: cleaned, html };
  }

  // 3) Too big → chunked map-reduce. No "context.trimmed" path anymore.
  emit('progress', { stage: 'context.too_large', tokens: tokLen(combined), budget: Math.min(CONTEXT_BUDGET, SMALL_SHOT_LIMIT) });

  const CHUNK_TOKENS = parseInt(process.env.QA_CHUNK_TOKENS || '4000', 10);
  const findings = [];

  for (const p of parts) {
    const filename = p.filename;
    const text = p.text || '';
    if (!text.trim()) continue;

    const chunks = splitIntoTokenChunks(text, CHUNK_TOKENS);
    emit('progress', { stage: 'file.chunking', file: filename, chunks: chunks.length, chunkTokens: CHUNK_TOKENS });

    // Process sequentially for stability; you can increase parallelism via OPENAI_PARALLEL
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      emit('progress', { stage: 'chunk.start', file: filename, index: i + 1, total: chunks.length });

      // Extra guard: trim an overgrown chunk further
      let safeChunk = chunkText;
      const MAX_SINGLE_CHUNK = Math.max(2000, CHUNK_TOKENS);
      if (tokLen(safeChunk) > MAX_SINGLE_CHUNK) {
        safeChunk = trimToTokens(safeChunk, MAX_SINGLE_CHUNK);
      }

      const answer = await answerChunk({
        question,
        filename,
        chunkText: safeChunk,
        openaiApiKey,
        hooks: { emit }
      });

      findings.push(`FILE: ${filename} | CHUNK ${i + 1}/${chunks.length}\n${answer}`);
      emit('progress', { stage: 'chunk.done', file: filename, index: i + 1, total: chunks.length });
    }
  }

  // 4) Aggregate
  emit('progress', { stage: 'aggregate.start', totalFindings: findings.length });
  const finalText = await aggregateAnswers({ question, findings, openaiApiKey, hooks: { emit } });
  emit('progress', { stage: 'aggregate.done' });

  const finalHtml = marked(sanitizeHtml(finalText, {
    allowedTags: ['b','i','strong','em','u','s','br','p','ul','ol','li','blockquote','code','pre','span','h1','h2','h3','h4','h5','h6'],
    allowedAttributes: { 'span': ['class'] },
    disallowedTagsMode: 'discard'
  }));

  return { text: finalText, html: finalHtml };
}

module.exports = { runUploadAndAskFullContent, QA_CORE_VERSION };
