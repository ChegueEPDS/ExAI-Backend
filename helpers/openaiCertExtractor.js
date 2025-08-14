// helpers/openaiCertExtractor.js
const axios = require('axios');

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
    required: ["certNo","manufacturer","product","exmarking","specCondition","xcondition","ucondition"]
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

  throw new Error(`Run timeout after ${Math.floor(timeoutMs/1000)}s`);
}

async function getLastAssistantText(threadId) {
  try {
    const r = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      }
    });
    const msg = r.data.data.find(m => m.role === 'assistant');
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
 * OCR → JSON mezők (Assistant v2)
 */
async function extractCertFieldsFromOCR(ocrText) {
  assertEnv();

  // Biztonsági trimmelés: ha túl hosszú az OCR, vágjuk ~60k karakterre
  const MAX_LEN = 60000;
  const ocr = (ocrText && ocrText.length > MAX_LEN) ? (ocrText.slice(0, MAX_LEN) + "\n...[TRUNCATED]") : ocrText;

  const systemPrompt = [
    "You are a strict JSON extractor for ATEX and IECEx certificates.",
    "Output exactly one JSON object that matches the requested fields.",
    "If a field is missing, return empty string for strings and false for booleans.",
    "Detect scheme: 'ATEX' or 'IECEx' if possible.",
    "Return 'issueDate' strictly in ISO 8601 format (YYYY-MM-DD), if a date is present; otherwise empty string.",
    "For 'specCondition', extract the exact text under headings like:",
    "'Special conditions for safe use', 'Specific conditions of use', 'Schedule of Limitations',",
    "'Special Conditions', 'Specific Conditions', 'Conditions for safe use', or similar.",
    "Return 'specCondition' as a single line; separate multiple items with '; '.",
    "IMPORTANT rules for X/U conditions:",
    "- Set xcondition = true if the certificate number contains an 'X' token AFTER the word ATEX or IECEx,",
    "  either as a separate token (e.g., 'ATEX 065 X') or appended (e.g., 'IECEx ABC 1234X').",
    "  Do NOT treat the 'X' in the words 'ATEX' or 'IECEx' themselves as an X-condition.",
    "- Set ucondition = true if the certificate number has a 'U' token or ends with '...U' (IECEx component).",
    "- ONLY extract and fill 'specCondition' when xcondition or ucondition is true; otherwise set it to an empty string and do not search for it.",
    "Return JSON only, with no markdown or extra text."
  ].join(' ');

  const userPrompt = [
    "Check the OCR result of the ATEX / IECEx certificate and return these fields in JSON:",
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

  // Első kör: json_object – modell-kompatibilisabb; hiba esetén fallback json_schema-ra
  try {
    await runAndWait(threadId, {
      assistant_id: ASSISTANT_ID,
      response_format: { type: 'json_object' }
    });
  } catch (e) {
    // 🔁 [LEGACY – json_schema erőltetése, ha támogatja a modell]
    await runAndWait(threadId, {
      assistant_id: ASSISTANT_ID,
      response_format: {
        type: 'json_schema',
        json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true }
      }
    });
  }

  const raw = await getLastAssistantText(threadId);

  // próbáljuk JSON-nek parse-olni
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  const safe = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(safe);
  } catch (e) {
    throw new Error(`Assistant did not return valid JSON. Raw: ${raw.slice(0, 300)}... (${e.message})`);
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
  }

  // If X or U condition applies but specCondition is empty, run a focused follow-up to extract only the conditions text
  if ((parsed.xcondition || parsed.ucondition) && (!parsed.specCondition || !parsed.specCondition.trim() || parsed.specCondition === "-")) {
    const followupPrompt = [
      "Extract ONLY the Special/Specific conditions text for safe use from the OCR.",
      "Look under headings like 'Special conditions for safe use', 'Specific conditions of use', 'Schedule of Limitations', 'Special/Specific Conditions', or similar.",
      "Return strictly this JSON and nothing else: { \"specCondition\": \"...\" }.",
      "Flatten to one line; separate multiple bullet points with '; '."
    ].join(' ');
    await addMessage(threadId, followupPrompt);
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
    const s2Start = raw2.indexOf('{');
    const s2End = raw2.lastIndexOf('}');
    const safe2 = s2Start >= 0 && s2End > s2Start ? raw2.slice(s2Start, s2End + 1) : raw2;
    try {
      const parsed2 = JSON.parse(safe2);
      if (parsed2 && typeof parsed2.specCondition === 'string') {
        parsed.specCondition = parsed2.specCondition;
      }
    } catch { /* ignore parse error of follow-up */ }
  }

  return parsed;
}

module.exports = { extractCertFieldsFromOCR };