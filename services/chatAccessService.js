const Conversation = require('../models/conversation');
const Tenant = require('../models/tenant');
const User = require('../models/user');
const { resolveAssistantContext } = require('../services/assistantResolver');

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
  const tenantDoc = await Tenant.findById(tenantId).select('name assistantId');
  if (!tenantDoc) {
    throw makeError(404, 'Tenant nem található.');
  }
  const { assistantId, tenantKey, source } = await resolveAssistantContext({ tenantId, tenantDoc, logTag });
  if (!assistantId) {
    throw makeError(500, 'Nincs beállítva asszisztens ehhez a tenant-hoz (ASSISTANT_ID_DEFAULT/tenant.assistantId).');
  }
  return { tenantDoc, assistantId, tenantKey, source };
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
