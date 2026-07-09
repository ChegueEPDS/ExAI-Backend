const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireAccess } = require('../middlewares/tenantAccessMiddleware');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');
const { diskUpload } = require('../middlewares/uploadFactory');
const controller = require('../controllers/documentationController');

const router = express.Router();
const upload = diskUpload({ fileSizeMb: 50, files: 1, fields: 20 });

router.get('/documentations', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'read'), controller.listDocumentations);
router.get('/documentations/expired-dashboard', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'read'), controller.listExpiredDocumentationsForDashboard);
router.post('/documentations', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'create'), upload.single('file'), controller.createDocumentation);
router.put('/documentations/:id', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'update'), controller.updateDocumentation);
router.delete('/documentations/:id', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'delete'), controller.deleteDocumentation);
router.get('/documentations/hierarchy', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'read'), controller.getHierarchy);
router.get('/documentations/:id/assignments', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'read'), controller.getAssignments);
router.put('/documentations/:id/assignments', authMiddleware(), requireTenantFeature('documentation'), requireAccess('documentation', 'update'), controller.replaceAssignments);

module.exports = router;
