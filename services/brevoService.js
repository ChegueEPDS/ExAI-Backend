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

function configuredListId(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getManagedEmailLists() {
  return {
    newsletter: {
      en: configuredListId('BREVO_NEWSLETTER_EN_LIST_ID', 6),
      hu: configuredListId('BREVO_NEWSLETTER_HU_LIST_ID', 7),
    },
    usefulInformation: configuredListId('BREVO_USEFUL_INFORMATION_LIST_ID', 8),
  };
}

function newsletterListForLanguage(language) {
  const lists = getManagedEmailLists().newsletter;
  return language === 'hu' ? lists.hu : lists.en;
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

async function getContact(email) {
  if (!email) return { skipped: true, reason: 'missing_email' };
  return brevoRequest('get', `/contacts/${encodeURIComponent(String(email).trim().toLowerCase())}`);
}

async function updateContact({ email, listIds = [], unlinkListIds = [], attributes = {}, emailBlacklisted }) {
  if (!email) return { skipped: true, reason: 'missing_email' };
  const body = {};
  if (Array.isArray(listIds) && listIds.length) body.listIds = [...new Set(listIds.map(Number).filter(Number.isFinite))];
  if (Array.isArray(unlinkListIds) && unlinkListIds.length) body.unlinkListIds = [...new Set(unlinkListIds.map(Number).filter(Number.isFinite))];
  if (attributes && Object.keys(attributes).length) body.attributes = attributes;
  if (typeof emailBlacklisted === 'boolean') body.emailBlacklisted = emailBlacklisted;
  if (!Object.keys(body).length) return { ok: true, status: 204 };
  return brevoRequest('put', `/contacts/${encodeURIComponent(String(email).trim().toLowerCase())}`, body);
}

async function syncEmailPreferences({
  email,
  usefulInformationEnabled = true,
  newsletterEnabled = true,
  preferredLanguage = 'en',
  restoreNewsletterListIds = [],
}) {
  if (!email) return { skipped: true, reason: 'missing_email' };
  const managed = getManagedEmailLists();
  const contactResult = await getContact(email);
  const contactMissing = contactResult?.status === 404;
  if (contactResult?.skipped || (contactResult?.ok === false && !contactMissing)) return contactResult;

  const currentListIds = Array.isArray(contactResult?.data?.listIds) ? contactResult.data.listIds.map(Number) : [];
  const newsletterIds = Object.values(managed.newsletter);
  const rememberedNewsletterListIds = currentListIds.filter(id => newsletterIds.includes(id));
  const restoreIds = (Array.isArray(restoreNewsletterListIds) ? restoreNewsletterListIds : [])
    .map(Number)
    .filter(id => newsletterIds.includes(id));
  const desiredNewsletterIds = newsletterEnabled
    ? (restoreIds.length ? restoreIds : [newsletterListForLanguage(preferredLanguage)])
    : [];
  const desiredAdd = [
    ...(usefulInformationEnabled ? [managed.usefulInformation] : []),
    ...desiredNewsletterIds,
  ];
  const desiredUnlink = [
    ...(!usefulInformationEnabled ? [managed.usefulInformation] : []),
    ...(!newsletterEnabled ? newsletterIds : newsletterIds.filter(id => !desiredNewsletterIds.includes(id))),
  ];

  const attributes = {};
  let result;
  if (contactMissing) {
    if (!desiredAdd.length) return { ok: true, status: 204, rememberedNewsletterListIds };
    result = await upsertContact({ email, attributes, listIds: desiredAdd });
  } else {
    result = await updateContact({
      email,
      listIds: desiredAdd,
      unlinkListIds: desiredUnlink,
      attributes,
      // Explicitly enabling at least one campaign category also reverses a prior
      // Brevo campaign block; disabled categories stay excluded by list membership.
      ...(desiredAdd.length ? { emailBlacklisted: false } : {}),
    });
  }
  return { ...result, rememberedNewsletterListIds };
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
async function onStripeCustomerCreated({ email, firstName, lastName, stripeCustomerId, tenant = null, user = null }) {
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

    const managedLists = getManagedEmailLists();
    const preferredLanguage = user?.preferredLanguage === 'hu' ? 'hu' : 'en';
    const listIds = [
      ...(user?.newsletterEmailsEnabled === false ? [] : [newsletterListForLanguage(preferredLanguage)]),
      ...(user?.marketingEmailsEnabled === false ? [] : [managedLists.usefulInformation]),
    ];
    const attrs = {
      FIRSTNAME: firstName || '',
      LASTNAME: lastName || '',
      STRIPE_CUSTOMER_ID: stripeCustomerId || '',
      TENANT_ID: tenant?._id ? String(tenant._id) : '',
      TENANT_NAME: tenant?.name || '',
      TENANT_TYPE: tenant?.type || '',
      PLAN: tenant?.plan || '',
      LANGUAGE: preferredLanguage,
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
  getContact,
  updateContact,
  syncEmailPreferences,
  getManagedEmailLists,
  newsletterListForLanguage,
  sendTransactionalTemplate,
};
