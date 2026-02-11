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
  maxOutputTokens = null,
  store = false,
  timeoutMs = 60_000,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const payload = {
    model: String(model || '').trim(),
    instructions: String(instructions || ''),
    input,
    store: !!store,
    ...(previousResponseId ? { previous_response_id: String(previousResponseId) } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(textFormat ? { text: { format: textFormat } } : {}),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
  };

  try {
    const resp = await axios.post('https://api.openai.com/v1/responses', payload, {
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
  maxOutputTokens = null,
  store = false,
  timeoutMs = 0,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const payload = {
    model: String(model || '').trim(),
    instructions: String(instructions || ''),
    input,
    store: !!store,
    stream: true,
    ...(previousResponseId ? { previous_response_id: String(previousResponseId) } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(textFormat ? { text: { format: textFormat } } : {}),
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
  };

  const resp = await axios({
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
  return resp.data; // node stream
}

module.exports = {
  createResponse,
  createResponseStream,
  extractOutputTextFromResponse,
};
