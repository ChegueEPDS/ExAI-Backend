// services/tenantMigration.js
const Certificate = require('../models/certificate');
// const Conversation = require('../models/conversation');
// const Projects = require('../models/project');
// stb.

exports.migrateAllUserDataToTenant = async (fromTenantId, toTenantId) => {
  // Tanúsítványok
  await Certificate.updateMany(
    { tenantId: fromTenantId },
    { $set: { tenantId: toTenantId } }
  );

  // Beszélgetések / projektek / fájlok / bármi más:
  // await Conversation.updateMany({ tenantId: fromTenantId }, { $set: { tenantId: toTenantId } });
  // await Projects.updateMany({ tenantId: fromTenantId }, { $set: { tenantId: toTenantId } });
  // ...
};