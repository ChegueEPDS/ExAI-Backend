const axios = require('axios');
const { marked } = require('marked');
const { resolveAssistantIdByTenantKey } = require('./assistantResolver');
const { extractOutputTextFromResponse } = require('../helpers/openaiResponses');
const { createResponse } = require('../helpers/openaiResponses');

marked.setOptions({ mangle: false, headerIds: false });

function resolveAssistantIdByTenant(tenantKey) {
  return resolveAssistantIdByTenantKey(tenantKey) || '';
}

async function fetchAssistantInfo(assistantId) {
  if (!assistantId) return { instructions: '', model: null };
  const resp = await axios.get(`https://api.openai.com/v1/assistants/${assistantId}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'assistants=v2' }
  });
  return {
    instructions: String(resp.data?.instructions || ''),
    model: resp.data?.model ? String(resp.data.model) : null,
  };
}

async function runDataplateAssistant({ tenantKey, message }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing; dataplate reader cannot run.');
  }
  const assistantId = resolveAssistantIdByTenant(String(tenantKey || '').toLowerCase());
  if (!assistantId) {
    throw new Error('ASSISTANT_ID is not configured for this tenant.');
  }

  const assistantInfo = await fetchAssistantInfo(assistantId);
  const model = String(assistantInfo?.model || 'gpt-5-mini').trim() || 'gpt-5-mini';

  const payload = {
    model,
    store: true,
    instructions: String(assistantInfo?.instructions || ''),
    input: [{ role: 'user', content: String(message || '') }],
  };
  const respObj = await createResponse({
    model: payload.model,
    instructions: payload.instructions,
    input: payload.input,
    store: true,
    temperature: 0,
    maxOutputTokens: 1200,
    timeoutMs: 120_000,
  });

  const txt = extractOutputTextFromResponse(respObj);
  const cleaned = String(txt || '').replace(/【[^【】\n\r]{0,200}】/g, '');
  const html = marked(cleaned);
  return { html, assistantId, model, responseId: respObj?.id || null };
}

module.exports = { runDataplateAssistant, resolveAssistantIdByTenant };
