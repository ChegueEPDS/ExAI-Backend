// services/tenantCleanup.js
const Certificate = require('../models/certificate');
const CompanyCertificateLink = require('../models/companyCertificateLink');
// const Conversation = require('../models/conversation'); // ha van
// stb.

exports.migrateDeleteCompanyDataButKeepPublic = async (tenantId) => {
  // public cert-ek maradnak a DB-ben, de tenant nélkül
  await Certificate.updateMany(
    { tenantId, visibility: 'public' },
    { $unset: { tenantId: "" } }
  );

  // private cert-ek törlése
  await Certificate.deleteMany({ tenantId, visibility: { $ne: 'public' } });

  // linkek törlése
  await CompanyCertificateLink.deleteMany({ tenantId });

  // ide jöhet minden más entitás törlése a company tenant alatt:
  // await Conversation.deleteMany({ tenantId });
  // ...
};