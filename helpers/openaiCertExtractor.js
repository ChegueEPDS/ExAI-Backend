// helpers/openaiCertExtractor.js
const axios = require('axios');
const { jsonrepair } = require('jsonrepair');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Global axios request timeout (per HTTP call)
axios.defaults.timeout = 60000; // 60s

// --- transient error helpers + retry wrapper ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isTransientError(err) {
  const status = err?.response?.status;
  const code = err?.code;
  // Treat 429, 5xx and common network hiccups as transient
  return status === 429 ||
    (status >= 500 && status < 600) ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED';
}

async function withRetry(fn, { retries = 5, baseDelay = 500, maxDelay = 5000 } = {}) {
  let attempt = 0;
  let delay = baseDelay;
  const jitter = () => Math.floor(Math.random() * Math.min(250, Math.floor(delay / 2)));
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isTransientError(err) || attempt > retries) throw err;
      await sleep(delay + jitter());
      delay = Math.min(maxDelay, Math.floor(delay * 1.8));
    }
  }
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID_CERT || process.env.ASSISTANT_ID || process.env.ASSISTANT_ID_DEFAULT; // dedikált asszisztens ajánlott

// JSON schema - kényszerítjük a kimenetet (fallbackként is használható)
const jsonSchema = {
  name: "certificate_fields",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scheme: { type: "string", description: "ATEX or IECEx (detect if possible)" },
      certNo: { type: "string" },
      manufacturer: { type: "string" },
      product: { type: "string" },
      exmarking: { type: "string" },
      specCondition: { type: "string" },
      xcondition: { type: "boolean", description: "true if 'X' condition applies" },
      ucondition: { type: "boolean", description: "true if 'U' component condition applies" },
      status: { type: "string" },
      issueDate: { type: "string" }
    },
    required: ["certNo", "manufacturer", "product", "exmarking", "specCondition", "xcondition", "ucondition"]
  }
};

// Secondary schema used for follow-up extraction when X-condition is detected but specCondition is empty
const specOnlySchema = {
  name: "spec_only",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      specCondition: { type: "string" }
    },
    required: ["specCondition"]
  }
};

function assertEnv() {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!ASSISTANT_ID) throw new Error("ASSISTANT_ID_CERT/ASSISTANT_ID/ASSISTANT_ID_DEFAULT is missing");
}

function enhanceAxiosError(phase, err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const detail = data?.error?.message || JSON.stringify(data);
  const msg = `[OpenAI ${phase}] ${status || ''} ${detail || err.message}`;
  return new Error(msg);
}

/**
 * Pre-sanitize assistant JSON-like text before parsing.
 * - Normalizes smart quotes to straight quotes
 * - Escapes naked quotes inside parentheses (e.g., ("db") -> (\"db\"))
 * - Keeps other JSON structure intact
 */
function preSanitizeJsonLike(input) {
  if (!input) return input;
  let s = String(input);

  // Normalize smart quotes
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // Escape quotes that appear inside parentheses and are not already escaped:
  //  - ("db") -> (\"db\")
  //  - ("tb") -> (\"tb\")
  //  - Gas("db") -> Gas(\"db\")
  //  - Dust("tb") -> Dust(\"tb\")
  // We only touch quotes that are inside (...) to avoid breaking JSON keys.
  s = s.replace(/\(([^)]*?)\)/g, (m) => {
    // Inside each (...) escape any unescaped double quotes
    const inner = m.slice(1, -1).replace(/(^|[^\\])"/g, '$1\\"');
    return `(${inner})`;
  });

  return s;
}

// --- tolerant JSON parser for imperfect LLM outputs ---
function parseLLMJson(raw) {
  if (!raw) return null;

  // ---- 0) Strip markdown fences & normalize whitespace ----
  let s = String(raw).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\r\n/g, '\n')
    .trim();

  // ---- 1) Pre-sanitize suspicious constructs (smart quotes + quotes in parentheses) ----
  s = preSanitizeJsonLike(s);

  // Helper: try native JSON.parse, falling back to jsonrepair
  const tryParse = (text) => {
    try { return JSON.parse(text); } catch {}
    try { return JSON.parse(jsonrepair(text)); } catch {}
    return null;
  };

  // Quick win: try parse the full thing after normalization
  let out = tryParse(s);
  if (out) return out;

  // ---- 2) Extract the largest JSON object core and try again ----
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b !== -1 && b > a) {
    const core = s.slice(a, b + 1);
    out = tryParse(core);
    if (out) return out;

    // ---- 3) Heuristic fix for unescaped inner quotes inside common string fields ----
    // Problematic pattern seen in OCR outputs: ("db") or similar embedded quotes within values.
    // We target known text fields and escape any *unescaped* quotes within their value ranges.
    const escapeUnescapedQuotes = (value) => {
      if (typeof value !== 'string') return value;
      let res = '';
      let prev = '';
      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '"' && prev !== '\\') {
          res += '\\"';
        } else {
          res += ch;
        }
        prev = ch === '\\' && prev === '\\' ? '' : ch;
      }
      return res;
    };

    const escapeField = (text, fieldName) => {
      const re = new RegExp(`("${fieldName}"\\s*:\\s*)"([\\s\\S]*?)"`, 'g');
      return text.replace(re, (_m, before, val) => {
        const fixedVal = escapeUnescapedQuotes(val);
        return `${before}"${fixedVal}"`;
      });
    };

    let fixed = core;
    // Apply to the most likely long/free-text fields first
    fixed = escapeField(fixed, 'specCondition');
    fixed = escapeField(fixed, 'exmarking');
    fixed = escapeField(fixed, 'product');
    fixed = escapeField(fixed, 'description');

    out = tryParse(fixed);
    if (out) return out;

    // ---- 4) Last-resort: cut at last closing brace on the fixed string and retry ----
    const lb = fixed.lastIndexOf('}');
    if (lb !== -1) {
      const cut = fixed.slice(0, lb + 1);
      out = tryParse(cut);
      if (out) return out;
    }
  }

  // ---- 5) Nothing worked ----
  return null;
}

// --- chunking + heuristic extractor for Spec Conditions (no token limits) ---
function splitIntoChunks(text, size = 60000, overlap = 1000) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    const chunk = text.slice(i, end);
    out.push(chunk);
    if (end >= text.length) break;
    i = end - overlap; // step back a little to avoid cutting a heading
    if (i < 0) i = 0;
  }
  return out;
}

/**
 * Try to pull the "Special/Specific conditions ..." block directly from raw OCR text,
 * without using the LLM (deterministic, covers any document length).
 */
function extractSpecFromOCRHeuristics(ocr) {
  if (!ocr) return '';
  const H = [
    'SPECIAL CONDITIONS FOR SAFE USE',
    'SPECIFIC CONDITIONS OF USE',
    'SCHEDULE OF LIMITATIONS',
    'SPECIAL CONDITIONS',
    'SPECIFIC CONDITIONS',
    'CONDITIONS FOR SAFE USE'
  ];
  const headingRe = new RegExp(
    '\\b(' + H.map(h => h.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
  );

  // Stop at typical new section starters
  const stopRe = /\b(annex|appendix|marking|markings|marking requirements|equipment|schedule|notes?|note\s*\d+|end of document)\b/i;

  const lines = String(ocr).split(/\r?\n/);
  let capture = false;
  const buf = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const line = rawLine.replace(/\u00A0/g, ' ').trim();

    if (!capture && headingRe.test(line)) {
      capture = true;
      continue; // skip the heading line itself
    }
    if (!capture) continue;

    // Termination conditions
    if (!line) {
      // allow small empty gaps inside bullet lists
      // but stop if we hit a long empty break
      const next = (lines[idx + 1] || '').trim();
      const next2 = (lines[idx + 2] || '').trim();
      if (!next || stopRe.test(next) || !next2 || stopRe.test(next2)) break;
      continue;
    }
    if (stopRe.test(line)) break;

    buf.push(line);
  }

  // Post-process: join bullets into one line
  const text = buf.join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

function stripAtexWords(s) {
  return String(s || '').replace(/ATEX|IECEX/gi, '');
}

function detectXFromCertNo(certNo) {
  const s = stripAtexWords(certNo);
  // Detect standalone X or an X appended to an alphanumeric token (e.g., 065 X, 1234X)
  return /\bX\b/i.test(s) || /\b[A-Za-z0-9]+X\b/i.test(s);
}

function detectUFromCertNo(certNo) {
  const s = stripAtexWords(certNo);
  // Typical IECEx component numbering ends with U (e.g., 1234U)
  return /\bU\b/i.test(s) || /\b[A-Za-z0-9]+U\b/i.test(s);
}

function dumpRawIfParseFails(tag, raw) {
  try {
    const dir = path.join(os.tmpdir(), 'cert-extract-dumps');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tag || 'noid'}_${Date.now()}.txt`);
    fs.writeFileSync(file, String(raw), 'utf8');
    console.warn(`[extractor] saved raw assistant output to: ${file}`);
  } catch { }
}

async function createThread() {
  try {
    const r = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
      }
    });
    return r.data.id;
  } catch (err) {
    throw enhanceAxiosError('createThread', err);
  }
}

async function addMessage(threadId, content) {
  try {
    // A conversationService-ben stringet küldesz; itt is kompatibilisek maradunk a v2 API-val
    await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`,
      { role: 'user', content },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json',
        }
      }
    );
  } catch (err) {
    throw enhanceAxiosError('addMessage', err);
  }
}

async function runAndWait(threadId, payload, {
  timeoutMs = 10 * 60 * 1000,    // 10 minutes total wait
  pollBaseDelay = 1000,          // start polling at 1s
  pollMaxDelay = 10000           // cap polling at 10s
} = {}) {
  let runId;
  try {
    const run = await withRetry(() => axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json',
        },
        timeout: 60000
      }
    ));
    runId = run.data.id;
  } catch (err) {
    throw enhanceAxiosError('createRun', err);
  }

  const start = Date.now();
  let delay = pollBaseDelay;

  while ((Date.now() - start) < timeoutMs) {
    await sleep(delay);
    try {
      const st = await withRetry(() => axios.get(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'OpenAI-Beta': 'assistants=v2',
          },
          timeout: 30000
        }
      ));

      const status = st.data.status;
      if (status === 'completed') return;
      if (['failed', 'cancelled', 'expired'].includes(status)) {
        throw new Error(`Run failed: ${status}`);
      }

      // Exponential backoff for the next poll, capped at pollMaxDelay
      delay = Math.min(pollMaxDelay, Math.floor(delay * 1.6));
    } catch (err) {
      if (isTransientError(err)) {
        // transient issue while polling, increase delay and continue
        delay = Math.min(pollMaxDelay, Math.floor(delay * 1.8));
        continue;
      }
      throw enhanceAxiosError('pollRun', err);
    }
  }

  throw new Error(`Run timeout after ${Math.floor(timeoutMs / 1000)}s`);
}

async function getLastAssistantText(threadId) {
  try {
    const r = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      }
    });
    const msgs = (r.data?.data || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const msg = msgs.find(m => m.role === 'assistant');
    if (!msg) throw new Error('No assistant message');
    let out = '';
    for (const c of msg.content) {
      if (c.type === 'text' && c.text?.value) out += c.text.value;
    }
    return out.trim();
  } catch (err) {
    throw enhanceAxiosError('getMessages', err);
  }
}

/**
 * LAST-RESORT deterministic extractor (regex-based) from raw OCR,
 * used only if the LLM JSON parse fails completely.
 * Returns a minimal-but-complete object compatible with the expected shape.
 */
function fallbackExtractFromOCR(ocrRaw) {
  if (!ocrRaw || typeof ocrRaw !== 'string') return null;
  const text = ocrRaw.replace(/\u00A0/g, ' ').replace(/\r/g, '');

  const out = {
    scheme: '',
    certNo: '',
    manufacturer: '',
    product: '',
    exmarking: '',
    specCondition: '',
    xcondition: false,
    ucondition: false,
    status: '',
    issueDate: ''
  };

  // --- scheme detection ---
  if (/IECEx/i.test(text)) out.scheme = 'IECEx';
  else if (/ATEX/i.test(text)) out.scheme = 'ATEX';

  // --- certificate number ---
  // 1) Try explicit "Certificate No" line
  let m = text.match(/Certificate\s*No\s*[:：]?\s*([^\n\r]+)/i);
  if (m) {
    out.certNo = m[1].trim();
  }
  // 2) If still empty, grab the first IECEx/ATEX-like number pattern on one line
  if (!out.certNo) {
    m = text.match(/\b(IECEx|ATEX)[^\n\r]{2,100}?(\b[0-9A-Za-z][^\n\r]{0,40})/i);
    if (m) {
      out.certNo = `${m[0]}`.trim();
    }
  }
  // cleanup extra spaces
  out.certNo = out.certNo.replace(/\s{2,}/g, ' ').trim();

  // --- manufacturer / applicant ---
  // Prefer "Manufacturer:" then fall back to "Applicant:"
  m = text.match(/Manufacturer\s*[:：]\s*([^\n\r]+)/i);
  if (m) out.manufacturer = m[1].trim();
  if (!out.manufacturer) {
    m = text.match(/Applicant\s*[:：]\s*([^\n\r]+)/i);
    if (m) out.manufacturer = m[1].trim();
  }

  // --- product/equipment ---
  m = text.match(/Equipment\s*[:：]\s*([^\n\r]+)/i);
  if (m) out.product = m[1].trim();
  if (!out.product) {
    m = text.match(/Device\s*[:：]\s*([^\n\r]+)/i);
    if (m) out.product = m[1].trim();
  }

  // --- ex marking block ---
  // Consider lines beginning with Ex ... (allow multiple lines)
  const exLines = [];
  const lines = text.split(/\n/);
  for (const line of lines) {
    const L = line.trim();
    if (/^Ex\s/i.test(L)) {
      exLines.push(L);
    }
  }
  if (exLines.length) {
    out.exmarking = exLines.join(' ');
  }

  // --- status ---
  m = text.match(/Status\s*[:：]\s*([^\n\r]+)/i);
  if (m) out.status = m[1].trim();

  // --- issue date ---
  // Prefer "Date of Issue:" style
  m = text.match(/Date\s+of\s+Issue\s*[:：]\s*([^\n\r]+)/i);
  if (m) out.issueDate = (m[1] || '').trim();
  // ISO-ize common formats (YYYY-MM-DD or YYYY.MM.DD or DD.MM.YYYY)
  const dateNorm = out.issueDate
    .replace(/(\d{4})[.\-/](\d{2})[.\-/](\d{2})/, '$1-$2-$3')
    .replace(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/, '$3-$2-$1');
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateNorm)) out.issueDate = dateNorm;

  // --- X / U conditions from certNo (reuse same rules as main path) ---
  out.xcondition = detectXFromCertNo(out.certNo);
  out.ucondition = detectUFromCertNo(out.certNo);

  // --- specCondition via deterministic heuristics (full text) ---
  if (out.xcondition || out.ucondition) {
    const spec = extractSpecFromOCRHeuristics(text);
    if (spec && spec !== '-') out.specCondition = spec;
  } else {
    out.specCondition = '';
  }

  // Final trims
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = out[k].replace(/\s+/g, ' ').trim();
  }

  // If we have at least a certNo, consider it a usable fallback
  if (out.certNo) return out;
  return null;
}

/**
 * OCR → JSON mezők (Assistant v2)
 */
async function extractCertFieldsFromOCR(ocrText) {
  assertEnv();

  // We keep a generous limit for the main run (to stay within model context),
  // but we ALWAYS search the full OCR for specCondition via heuristics/chunking below.
  const MAX_LEN = 120000; // allow larger prompts for better recall
  const ocr = (ocrText && ocrText.length > MAX_LEN) ? (ocrText.slice(0, MAX_LEN) + "\n...[TRUNCATED]") : ocrText;
  const ocrFull = ocrText || '';

  const systemPrompt = [
    "You are a strict JSON extractor for ATEX and IECEx certificates.",
    "Output exactly one JSON object that matches the requested fields.",
    "If a field is missing, return empty string for strings and false for booleans.",
    "Detect scheme: 'ATEX' or 'IECEx' if possible.",
    "Return 'issueDate' strictly in ISO 8601 format (YYYY-MM-DD), if a date is present; otherwise empty string.",
    "For 'specCondition', extract the exact text under headings like:",
    "'Special conditions for safe use', 'Specific conditions of use', 'Schedule of Limitations',",
    "'Special Conditions', 'Specific Conditions', 'Conditions for safe use', or similar.",
    "Preserve the original language of the certificate. Do NOT translate anything.",
    "Return all text fields exactly as they appear in the source (including accents/diacritics and capitalization); only normalize whitespace.",
    "Return 'specCondition' as a single line; separate multiple items with '; '.",
    "IMPORTANT rules for X/U conditions:",
    "- Set xcondition = true if the certificate number contains an 'X' token AFTER the word ATEX or IECEx,",
    "  either as a separate token (e.g., 'ATEX 065 X') or appended (e.g., 'IECEx ABC 1234X').",
    "  Do NOT treat the 'X' in the words 'ATEX' or 'IECEx' themselves as an X-condition.",
    "- Set ucondition = true if the certificate number has a 'U' token or ends with '...U' (IECEx component).",
    "- ONLY extract and fill 'specCondition' when xcondition or ucondition is true; otherwise set it to an empty string and do not search for it.",
    "Return JSON only, with no markdown or extra text.",
    "Return ONLY a minified JSON object. No prose. No markdown. No code fences."
  ].join(' ');

  const userPrompt = [
    "Check the OCR result of the ATEX / IECEx certificate and return these fields in JSON:",
    "IMPORTANT: Preserve original language from OCR; DO NOT translate any field (manufacturer, product, exmarking, specCondition, status, etc.).",
    "scheme, certNo, manufacturer, product, exmarking, specCondition, xcondition, ucondition, status, issueDate.",
    "For 'specCondition', use any of these headings if present: Special conditions for safe use; Specific conditions of use;",
    "Schedule of Limitations; Special/Specific Conditions; Conditions for safe use.",
    "IMPORTANT: Only extract specCondition when the certificate number shows X or U AFTER the word ATEX/IECEx (not the X in 'ATEX' or 'IECEx' themselves).",
    "If there is no such X or U, set specCondition to an empty string.",
    "",
    "OCR:",
    "-----",
    ocr,
    "-----"
  ].join('\n');

  const threadId = await createThread();
  await addMessage(threadId, `${systemPrompt}\n\n${userPrompt}`);

  // Első kör: json_schema (strict) – kényszerített valid JSON; hiba esetén fallback json_object-ra
  try {
    await runAndWait(threadId, {
      assistant_id: ASSISTANT_ID,
      response_format: {
        type: 'json_schema',
        json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true }
      }
    });
  } catch (e) {
    await runAndWait(threadId, {
      assistant_id: ASSISTANT_ID,
      response_format: { type: 'json_object' }
    });
  }

  const raw = await getLastAssistantText(threadId);

  // próbáljuk JSON-nek parse-olni (tűrő parserrel)
  let parsed = parseLLMJson(raw);
  if (!parsed) {
    // dump raw a hibakereséshez
    dumpRawIfParseFails('main', raw);

    // 🔥 LAST-RESORT: try deterministic regex-based extraction on full OCR
    const fb = fallbackExtractFromOCR(ocrFull);
    if (fb) {
      return fb;
    }

    // If even fallback failed, give the original error
    throw new Error(`Assistant did not return valid JSON (repair failed). Raw: ${String(raw).slice(0, 300)}...`);
  }

  // defaultok (ha üres lenne)
  parsed.scheme ??= "";
  parsed.certNo ??= "";
  parsed.manufacturer ??= "";
  parsed.product ??= "";
  parsed.exmarking ??= "";
  parsed.specCondition ??= "";
  parsed.xcondition = !!parsed.xcondition;
  parsed.ucondition = !!parsed.ucondition;
  parsed.status ??= "";
  parsed.issueDate ??= "";

  // Fallback detection for X/U based strictly on the certificate number (ignoring the 'X' in the words 'ATEX'/'IECEx')
  const autoX = detectXFromCertNo(parsed.certNo);
  const autoU = detectUFromCertNo(parsed.certNo);

  // Enforce booleans from certNo only, to avoid false positives from generic explanatory text
  parsed.xcondition = !!autoX;
  parsed.ucondition = !!autoU;

  // If neither X nor U is present in certNo, do not carry any conditions text
  if (!parsed.xcondition && !parsed.ucondition) {
    parsed.specCondition = "";
  } else {
    // 1) Try deterministic heuristic extraction from the FULL OCR (not truncated)
    const specFromOCR = extractSpecFromOCRHeuristics(ocrFull);
    if (specFromOCR && specFromOCR !== "-") {
      parsed.specCondition = specFromOCR;
    }

    // 2) If still empty, try chunked LLM follow-up ONLY on segments that might contain the section
    if (!parsed.specCondition || !parsed.specCondition.trim()) {
      const chunks = splitIntoChunks(ocrFull, 60000, 1200);
      const headingHint = /(special|specific)\s+conditions|schedule\s+of\s+limitations|conditions\s+for\s+safe\s+use/i;
      for (const chunk of chunks) {
        if (!headingHint.test(chunk)) continue; // skip chunks without any hint to save calls
        await addMessage(threadId, [
          "Extract ONLY the Special/Specific conditions text for safe use from the OCR CHUNK below.",
          "Look under headings like 'Special conditions for safe use', 'Specific conditions of use', 'Schedule of Limitations', 'Special/Specific Conditions', or similar.",
          "Return strictly this JSON and nothing else: { \"specCondition\": \"...\" }.",
          "Flatten to one line; separate multiple bullet points with '; '.",
          "",
          "OCR CHUNK:",
          "-----",
          chunk,
          "-----"
        ].join('\n'));

        await runAndWait(threadId, {
          assistant_id: ASSISTANT_ID,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: specOnlySchema.name,
              schema: specOnlySchema.schema,
              strict: true
            }
          }
        });

        const raw2 = await getLastAssistantText(threadId);
        const parsed2 = parseLLMJson(raw2);
        if (parsed2 && typeof parsed2.specCondition === 'string' && parsed2.specCondition.trim()) {
          parsed.specCondition = parsed2.specCondition.trim();
          break;
        }
      }
    }
  }

  return parsed;
}

module.exports = { extractCertFieldsFromOCR };