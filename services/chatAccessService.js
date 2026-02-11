const Conversation = require('../models/conversation');
const Tenant = require('../models/tenant');
const User = require('../models/user');

function makeError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function resolveUserAndTenant(req) {
  const userId = req.userId;
  if (!userId) {
    throw makeError(400, 'Bejelentkezett felhasználó azonosítója hiányzik.');
  }

  const user = await User.findById(userId).select('tenantId');
  const tenantId = req.scope?.tenantId || (user?.tenantId ? String(user.tenantId) : null);
  if (!tenantId) {
    throw makeError(403, 'Hiányzó tenant azonosító.');
  }
  if (!user) {
    throw makeError(404, 'Felhasználó nem található.');
  }

  return { userId, user, tenantId };
}

async function resolveAssistantForTenant(tenantId, logTag = 'CHAT') {
  // Backward-compatible name:
  // This used to resolve an OpenAI assistantId (Assistants API). We no longer rely on Assistants API.
  // It now only resolves tenant metadata (name -> tenantKey) for logging and per-tenant behavior.
  const tenantDoc = await Tenant.findById(tenantId).select('name');
  if (!tenantDoc) {
    throw makeError(404, 'Tenant nem található.');
  }
  const tenantKey = String(tenantDoc?.name || '').toLowerCase() || null;
  const source = 'tenantDoc.name';
  if (logTag) {
    try {
      // best-effort debug log (keeps existing log shape, but no Assistants API dependency)
      const logger = require('../config/logger');
      logger.debug(`[ASSISTANT PICK][${logTag}]`, { tenantId: String(tenantId), tenantKey, assistantId: null, source });
    } catch {}
  }
  return { tenantDoc, assistantId: null, tenantKey, source };
}

async function ensureConversationOwnership({ threadId, userId, tenantId }) {
  const conversation = await Conversation.findOne({ threadId, userId, tenantId });
  if (!conversation) {
    throw makeError(404, 'A megadott szál nem található.');
  }
  if (String(conversation.userId) !== String(userId)) {
    throw makeError(403, 'A beszélgetés nem tartozik a felhasználóhoz.');
  }
  return conversation;
}

module.exports = {
  resolveUserAndTenant,
  resolveAssistantForTenant,
  ensureConversationOwnership,
};
