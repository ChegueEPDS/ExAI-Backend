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

async function createResponse({
  model,
  instructions = '',
  input,
  previousResponseId = null,
  tools = null,
  textFormat = null,
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
    ...(textFormat ? { text: { format: textFormat } } : {}),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(topP === null || topP === undefined ? {} : { top_p: topP }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(truncation === null || truncation === undefined ? {} : { truncation }),
    ...(reasoningEffort ? { reasoning: { effort: String(reasoningEffort) } } : {}),
  };

  const strippedPayload = { ...basePayload };
  delete strippedPayload.top_p;
  delete strippedPayload.truncation;
  delete strippedPayload.reasoning;

  const hasOptionals =
    Object.prototype.hasOwnProperty.call(basePayload, 'top_p') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'truncation') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'reasoning');

  try {
    const resp = await axios.post('https://api.openai.com/v1/responses', basePayload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: timeoutMs,
    });
    return resp.data;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const detail =
      data && typeof data === 'object'
        ? JSON.stringify(data).slice(0, 2000)
        : data
          ? String(data).slice(0, 2000)
          : '';
    // Best-effort fallback: if optional knobs aren't supported by the chosen model,
    // retry once without them to avoid hard failures in prod.
    if (status === 400 && hasOptionals) {
      try {
        const resp2 = await axios.post('https://api.openai.com/v1/responses', strippedPayload, {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          timeout: timeoutMs,
        });
        return resp2.data;
      } catch (e2) {
        const status2 = e2?.response?.status;
        const data2 = e2?.response?.data;
        const detail2 =
          data2 && typeof data2 === 'object'
            ? JSON.stringify(data2).slice(0, 2000)
            : data2
              ? String(data2).slice(0, 2000)
              : '';
        const msg2 = status2
          ? `OpenAI Responses API error ${status2}: ${detail2 || e2?.message || 'request_failed'}`
          : (e2?.message || 'request_failed');
        const err2 = new Error(msg2);
        err2.status = status2;
        err2.detail = detail2;
        throw err2;
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
    ...(textFormat ? { text: { format: textFormat } } : {}),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(topP === null || topP === undefined ? {} : { top_p: topP }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(truncation === null || truncation === undefined ? {} : { truncation }),
    ...(reasoningEffort ? { reasoning: { effort: String(reasoningEffort) } } : {}),
  };

  const strippedPayload = { ...basePayload };
  delete strippedPayload.top_p;
  delete strippedPayload.truncation;
  delete strippedPayload.reasoning;
  const hasOptionals =
    Object.prototype.hasOwnProperty.call(basePayload, 'top_p') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'truncation') ||
    Object.prototype.hasOwnProperty.call(basePayload, 'reasoning');

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
    if (status === 400 && hasOptionals) {
      const resp2 = await axios({
        method: 'post',
        url: 'https://api.openai.com/v1/responses',
        data: strippedPayload,
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
    }
    throw e;
  }
}

module.exports = {
  createResponse,
  createResponseStream,
  extractOutputTextFromResponse,
};
