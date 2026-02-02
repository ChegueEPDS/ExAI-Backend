const assistants = require('../config/assistants');
const logger = require('../config/logger');
const Tenant = require('../models/tenant');

function resolveAssistantIdByTenantKey(tenantKey) {
  const key = String(tenantKey || '').toLowerCase();
  const byName = key ? assistants?.byTenant?.[key] : undefined;
  const def = assistants?.default || assistants?.['default'] || process.env.ASSISTANT_ID || null;
  return byName || def;
}

/**
 * Resolve assistant ID with priority:
 *   1) tenantDoc.assistantId (DB override)
 *   2) assistants.byTenantId[tenantId] (optional config)
 *   3) assistants.byTenant[tenantKey] (config)
 *   4) assistants.default (config)
 */
async function resolveAssistantContext({ tenantId, tenantDoc, logTag } = {}) {
  const tenantIdStr = tenantId ? String(tenantId) : null;
  let doc = tenantDoc || null;

  if (!doc && tenantIdStr) {
    doc = await Tenant.findById(tenantIdStr).select('name assistantId');
  }

  const tenantKey = String(doc?.name || '').toLowerCase() || null;
  const dbOverride = String(doc?.assistantId || '').trim() || null;
  const byTenantId = tenantIdStr ? assistants?.byTenantId?.[tenantIdStr] : undefined;
  const byTenantName = tenantKey ? assistants?.byTenant?.[tenantKey] : undefined;
  const def = assistants?.default || assistants?.['default'] || null;

  const assistantId = dbOverride || byTenantId || byTenantName || def || null;
  const source =
    (dbOverride && 'tenantDoc.assistantId') ||
    (byTenantId && 'assistants.byTenantId') ||
    (byTenantName && 'assistants.byTenant') ||
    (def && 'assistants.default') ||
    'missing';

  if (logTag) {
    logger.debug(`[ASSISTANT PICK][${logTag}]`, {
      tenantId: tenantIdStr,
      tenantKey,
      assistantId,
      source,
      hasDbOverride: !!dbOverride,
      hasByTenantId: !!byTenantId,
      hasByTenantName: !!byTenantName,
      defaultAssistantId: def,
    });
  }

  return { assistantId, tenantKey, tenantDoc: doc, source };
}

module.exports = { resolveAssistantContext, resolveAssistantIdByTenantKey };
