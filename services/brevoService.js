const axios = require('axios');
const logger = require('../config/logger');

function shouldTrace() {
  return String(process.env.BREVO_TRACE || process.env.BREVO_DEBUG || '').trim() === '1';
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function log(level, message, meta) {
  const line = meta ? `${message} ${safeJson(meta)}` : message;
  try {
    if (logger && typeof logger[level] === 'function') return logger[level](line);
  } catch {}
  try {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line);
  } catch {}
}

function parseListIds(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => Number(String(s).trim()))
    .filter(n => Number.isFinite(n) && n > 0);
}

async function brevoRequest(method, path, body) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    if (shouldTrace()) log('info', '[brevo] skipped (missing BREVO_API_KEY)', { path });
    return { skipped: true, reason: 'BREVO_API_KEY not set' };
  }

  const baseUrl = process.env.BREVO_BASE_URL || 'https://api.brevo.com/v3';
  const url = `${String(baseUrl).replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  const timeoutMs = Number(process.env.BREVO_TIMEOUT_MS) > 0 ? Number(process.env.BREVO_TIMEOUT_MS) : 8000;

  if (shouldTrace()) log('info', '[brevo] request', { method, path });

  const resp = await axios.request({
    method,
    url,
    data: body,
    timeout: timeoutMs,
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    validateStatus: () => true,
  });

  if (resp.status >= 200 && resp.status < 300) {
    if (shouldTrace()) log('info', '[brevo] response ok', { path, status: resp.status });
    return { ok: true, status: resp.status, data: resp.data };
  }

  const msgRaw = typeof resp.data === 'object' ? safeJson(resp.data) : String(resp.data || '');
  const msg = msgRaw.length > 1200 ? `${msgRaw.slice(0, 1200)}…` : msgRaw;
  log('warn', '[brevo] response error', { path, status: resp.status, error: msg });
  return { ok: false, status: resp.status, error: msg };
}

async function upsertContact({ email, attributes = {}, listIds = [] }) {
  if (!email) return { skipped: true, reason: 'missing_email' };
  if (shouldTrace()) log('info', '[brevo] upsertContact', { email, listIds });
  const body = {
    email,
    attributes,
    updateEnabled: true,
  };
  if (Array.isArray(listIds) && listIds.length) body.listIds = listIds;
  return brevoRequest('post', '/contacts', body);
}

async function sendTransactionalTemplate({ toEmail, templateId, params = {} }) {
  if (!toEmail) return { skipped: true, reason: 'missing_email' };
  const id = Number(templateId);
  if (!Number.isFinite(id) || id <= 0) return { skipped: true, reason: 'invalid_template_id' };
  if (shouldTrace()) log('info', '[brevo] sendTransactionalTemplate', { toEmail, templateId: id });

  return brevoRequest('post', '/smtp/email', {
    to: [{ email: toEmail }],
    templateId: id,
    params,
  });
}

/**
 * Trigger Brevo sync when a Stripe customer is created.
 * - Adds/updates the contact and (optionally) adds to list(s).
 * - Optionally sends a transactional email template if configured.
 */
async function onStripeCustomerCreated({ email, firstName, lastName, stripeCustomerId, tenant = null }) {
  try {
    if (shouldTrace()) {
      log('info', '[brevo] onStripeCustomerCreated', {
        email,
        stripeCustomerId,
        tenantId: tenant?._id ? String(tenant._id) : null,
        tenantName: tenant?.name || null,
        plan: tenant?.plan || null,
      });
    }

    const listIds = parseListIds(process.env.BREVO_LIST_IDS || process.env.BREVO_LIST_ID);
    const attrs = {
      FIRSTNAME: firstName || '',
      LASTNAME: lastName || '',
      STRIPE_CUSTOMER_ID: stripeCustomerId || '',
      TENANT_ID: tenant?._id ? String(tenant._id) : '',
      TENANT_NAME: tenant?.name || '',
      TENANT_TYPE: tenant?.type || '',
      PLAN: tenant?.plan || '',
    };

    const upsertResult = await upsertContact({
      email,
      attributes: attrs,
      listIds,
    });

    if (upsertResult?.ok === false) {
      log('warn', '[brevo] upsert contact failed', { email, status: upsertResult.status, error: upsertResult.error });
    }

    const templateId = process.env.BREVO_WELCOME_TEMPLATE_ID;
    const shouldSend =
      String(process.env.BREVO_SEND_WELCOME || '').trim() === '1' &&
      templateId;

    if (shouldSend) {
      const sendResult = await sendTransactionalTemplate({
        toEmail: email,
        templateId,
        params: {
          firstName: firstName || '',
          lastName: lastName || '',
          tenantName: tenant?.name || '',
          plan: tenant?.plan || '',
        },
      });
      if (sendResult?.ok === false) {
        log('warn', '[brevo] send transactional email failed', { email, status: sendResult.status, error: sendResult.error });
      }
    }
  } catch (err) {
    log('warn', '[brevo] onStripeCustomerCreated failed', { error: err?.message || String(err) });
  }
}

module.exports = {
  onStripeCustomerCreated,
  upsertContact,
  sendTransactionalTemplate,
};
