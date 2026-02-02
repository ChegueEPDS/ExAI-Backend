const axios = require('axios');
const { marked } = require('marked');

marked.setOptions({ mangle: false, headerIds: false });

const axiosInst = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'assistants=v2'
  },
  timeout: 60_000
});

const { resolveAssistantIdByTenantKey } = require('./assistantResolver');

function resolveAssistantIdByTenant(tenantKey) {
  return resolveAssistantIdByTenantKey(tenantKey) || '';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(threadId, runId, { maxMs = 60_000 } = {}) {
  const start = Date.now();
  let delayMs = 500;
  while (Date.now() - start < maxMs) {
    const { data } = await axiosInst.get(`/threads/${threadId}/runs/${runId}`);
    const s = data.status;
    if (s === 'completed') return data;
    if (s === 'requires_action') throw new Error('Assistant run requires_action (tool calls not handled).');
    if (s === 'failed' || s === 'cancelled' || s === 'expired') {
      const errMsg = data?.last_error?.message ? ` - ${data.last_error.message}` : '';
      throw new Error(`Assistant run ended with status: ${s}${errMsg}`);
    }
    await wait(delayMs);
    delayMs = Math.min(delayMs * 1.5, 3000);
  }
  throw new Error('Assistant run polling timeout.');
}

async function runDataplateAssistant({ tenantKey, message }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing; dataplate reader cannot run.');
  }
  const assistantId = resolveAssistantIdByTenant(String(tenantKey || '').toLowerCase());
  if (!assistantId) {
    throw new Error('ASSISTANT_ID is not configured for this tenant.');
  }

  const threadResp = await axiosInst.post('/threads', {});
  const threadId = threadResp.data.id;

  try {
    await axiosInst.post(`/threads/${threadId}/messages`, {
      role: 'user',
      content: message
    });

    const runResp = await axiosInst.post(`/threads/${threadId}/runs`, {
      assistant_id: assistantId
    });

    await waitForRun(threadId, runResp.data.id, { maxMs: 120_000 });

    const messagesResp = await axiosInst.get(`/threads/${threadId}/messages`, {
      params: { order: 'desc', limit: 10 }
    });

    const assistantMessage = (messagesResp.data?.data || []).find((m) => m.role === 'assistant');
    if (!assistantMessage) throw new Error('Assistant response missing.');

    let assistantContent = '';
    if (Array.isArray(assistantMessage.content)) {
      assistantMessage.content.forEach((item) => {
        if (item.type === 'text' && item.text && item.text.value) {
          assistantContent += item.text.value;
        }
      });
    } else {
      assistantContent = assistantMessage.content;
    }

    assistantContent = String(assistantContent || '').replace(/【[^【】\n\r]{0,200}】/g, '');
    const html = marked(assistantContent);
    return { html, assistantId };
  } finally {
    // best-effort cleanup to avoid thread buildup
    try {
      await axiosInst.delete(`/threads/${threadId}`);
    } catch {
      // ignore
    }
  }
}

module.exports = { runDataplateAssistant, resolveAssistantIdByTenant };
