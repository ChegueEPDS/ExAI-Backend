const axios = require('axios');

function extractOutputTextFromResponse(responseObj) {
  if (!responseObj) return '';
  if (typeof responseObj.output_text === 'string') return responseObj.output_text;
  const out = Array.isArray(responseObj.output) ? responseObj.output : [];
  let text = '';
  for (const item of out) {
    if (item?.type !== 'message') continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') {
        text += part.text;
      }
    }
  }
  return text;
}

function safeJsonStringify(v, maxLen = 2000) {
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  } catch {
    try {
      const s = String(v);
      return s.length > maxLen ? s.slice(0, maxLen) : s;
    } catch {
      return '';
    }
  }
}

function stripUnsupportedParam(payload, param) {
  const p = String(param || '').trim();
  if (!p) return payload;
  const next = { ...(payload || {}) };

  // Only strip safe, optional knobs. Do NOT strip core request fields.
  if (p === 'temperature') delete next.temperature;
  if (p === 'top_p') delete next.top_p;
  if (p === 'max_output_tokens') delete next.max_output_tokens;
  if (p === 'truncation') delete next.truncation;
  if (p === 'reasoning') delete next.reasoning;
  if (p === 'verbosity' || p === 'text.verbosity') {
    if (next.text && typeof next.text === 'object') {
      delete next.text.verbosity;
      if (!Object.keys(next.text).length) delete next.text;
    }
  }
  return next;
}

function stripAllOptionals(payload) {
  const next = { ...(payload || {}) };
  delete next.temperature;
  delete next.top_p;
  delete next.max_output_tokens;
  delete next.truncation;
  delete next.reasoning;
  if (next.text && typeof next.text === 'object') {
    delete next.text.verbosity;
    if (!Object.keys(next.text).length) delete next.text;
  }
  return next;
}

function detectUnsupportedParamFromError(data) {
  const param = data?.error?.param ? String(data.error.param) : '';
  if (param) return param;
  const msg = data?.error?.message ? String(data.error.message) : '';
  const m = msg.match(/Unsupported parameter:\s*'([^']+)'/i);
  return m?.[1] ? String(m[1]) : '';
}

async function createResponse({
  model,
  instructions = '',
  input,
  previousResponseId = null,
  tools = null,
  textFormat = null,
  textVerbosity = null,
  temperature = null,
  topP = null,
  maxOutputTokens = null,
  truncation = null,
  reasoningEffort = null,
  store = false,
  timeoutMs = 60_000,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const basePayload = {
    model: String(model || '').trim(),
    instructions: String(instructions || ''),
    input,
    store: !!store,
    ...(previousResponseId ? { previous_response_id: String(previousResponseId) } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(() => {
      const text = {};
      if (textFormat) text.format = textFormat;
      if (textVerbosity) text.verbosity = textVerbosity;
      return Object.keys(text).length ? { text } : {};
    })(),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(topP === null || topP === undefined ? {} : { top_p: topP }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(truncation === null || truncation === undefined ? {} : { truncation }),
    ...(reasoningEffort ? { reasoning: { effort: String(reasoningEffort) } } : {}),
  };

  const hasOptionals =
    Object.prototype.hasOwnProperty.call(basePayload, 'temperature') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'top_p') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'max_output_tokens') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'truncation') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'reasoning') ||
    (basePayload.text && Object.prototype.hasOwnProperty.call(basePayload.text, 'verbosity'));

  try {
    const resp = await axios.post('https://api.openai.com/v1/responses', basePayload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: timeoutMs,
    });
    return resp.data;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const detail = (data && typeof data === 'object') ? safeJsonStringify(data) : (data ? String(data).slice(0, 2000) : '');

    // Best-effort fallback: if optional knobs aren't supported by the chosen model,
    // retry a few times stripping only the unsupported parameter(s).
    if (status === 400 && hasOptionals) {
      let payload = { ...basePayload };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unsupported = detectUnsupportedParamFromError(data);
        const next = stripUnsupportedParam(payload, unsupported);
        // If we couldn't strip anything, abort retries.
        if (next === payload || safeJsonStringify(next) === safeJsonStringify(payload)) {
          // Fallback: drop all optional knobs in one go.
          payload = stripAllOptionals(payload);
        } else {
          payload = next;
        }
        try {
          const resp2 = await axios.post('https://api.openai.com/v1/responses', payload, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            timeout: timeoutMs,
          });
          return resp2.data;
        } catch (e2) {
          const status2 = e2?.response?.status;
          const data2 = e2?.response?.data;
          // Only continue retry loop on 400; otherwise rethrow as final.
          if (status2 !== 400) {
            const detail2 = (data2 && typeof data2 === 'object') ? safeJsonStringify(data2) : (data2 ? String(data2).slice(0, 2000) : '');
            const msg2 = status2
              ? `OpenAI Responses API error ${status2}: ${detail2 || e2?.message || 'request_failed'}`
              : (e2?.message || 'request_failed');
            const err2 = new Error(msg2);
            err2.status = status2;
            err2.detail = detail2;
            throw err2;
          }
        }
      }
    }

    const msg = status ? `OpenAI Responses API error ${status}: ${detail || e?.message || 'request_failed'}` : (e?.message || 'request_failed');
    const err = new Error(msg);
    err.status = status;
    err.detail = detail;
    throw err;
  }
}

async function createResponseStream({
  model,
  instructions = '',
  input,
  previousResponseId = null,
  tools = null,
  textFormat = null,
  textVerbosity = null,
  temperature = null,
  topP = null,
  maxOutputTokens = null,
  truncation = null,
  reasoningEffort = null,
  store = false,
  timeoutMs = 0,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const basePayload = {
    model: String(model || '').trim(),
    instructions: String(instructions || ''),
    input,
    store: !!store,
    stream: true,
    ...(previousResponseId ? { previous_response_id: String(previousResponseId) } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(() => {
      const text = {};
      if (textFormat) text.format = textFormat;
      if (textVerbosity) text.verbosity = textVerbosity;
      return Object.keys(text).length ? { text } : {};
    })(),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(topP === null || topP === undefined ? {} : { top_p: topP }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(truncation === null || truncation === undefined ? {} : { truncation }),
    ...(reasoningEffort ? { reasoning: { effort: String(reasoningEffort) } } : {}),
  };

  const hasOptionals =
    Object.prototype.hasOwnProperty.call(basePayload, 'temperature') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'top_p') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'max_output_tokens') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'truncation') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'reasoning') ||
    (basePayload.text && Object.prototype.hasOwnProperty.call(basePayload.text, 'verbosity'));

  try {
    const resp = await axios({
      method: 'post',
      url: 'https://api.openai.com/v1/responses',
      data: basePayload,
      responseType: 'stream',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        Connection: 'keep-alive'
      },
      timeout: timeoutMs,
    });
    return resp.data; // node stream
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (status === 400 && hasOptionals) {
      let payload = { ...basePayload };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unsupported = detectUnsupportedParamFromError(data);
        const next = stripUnsupportedParam(payload, unsupported);
        if (next === payload || safeJsonStringify(next) === safeJsonStringify(payload)) {
          payload = stripAllOptionals(payload);
        } else {
          payload = next;
        }
        try {
          const resp2 = await axios({
            method: 'post',
            url: 'https://api.openai.com/v1/responses',
            data: payload,
            responseType: 'stream',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              Connection: 'keep-alive'
            },
            timeout: timeoutMs,
          });
          return resp2.data;
        } catch (e2) {
          const status2 = e2?.response?.status;
          if (status2 !== 400) throw e2;
        }
      }
    }
    throw e;
  }
}

module.exports = {
  createResponse,
  createResponseStream,
  extractOutputTextFromResponse,
};
