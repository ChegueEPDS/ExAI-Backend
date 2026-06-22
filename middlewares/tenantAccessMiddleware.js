const access = require('../services/tenantAccessService');

function requireAccess(resource, action = 'read') {
  return (req, res, next) => access.requireAccess(req, res, next, resource, action);
}

module.exports = { requireAccess };
