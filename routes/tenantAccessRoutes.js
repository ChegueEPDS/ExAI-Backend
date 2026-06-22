const express = require('express');
const { authMiddleware } = require('../middlewares/authMiddleware');
const controller = require('../controllers/tenantAccessController');

const router = express.Router();

router.get('/tenants/:tenantId/access-config', authMiddleware(['Admin', 'SuperAdmin']), controller.getTenantAccessConfig);
router.get('/tenants/:tenantId/access-groups', authMiddleware(['Admin', 'SuperAdmin']), controller.listAccessGroups);
router.post('/tenants/:tenantId/access-groups', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.upsertAccessGroup);
router.put('/tenants/:tenantId/access-groups/:groupId', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.upsertAccessGroup);
router.delete('/tenants/:tenantId/access-groups/:groupId', authMiddleware(['Admin', 'SuperAdmin']), controller.deleteAccessGroup);
router.get('/users/:userId/access-groups', authMiddleware(['Admin', 'SuperAdmin']), controller.getUserAccessGroups);
router.put('/users/:userId/access-groups', authMiddleware(['Admin', 'SuperAdmin']), express.json(), controller.updateUserAccessGroups);

module.exports = router;
