const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/schemaController');
const { requireTenantFeature } = require('../middlewares/tenantFeatureMiddleware');

const router = express.Router();

router.get('/schemas', authMiddleware(), controller.list);
router.post('/schemas', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), controller.create);
router.post('/schemas/rb/seed', authMiddleware(['SuperAdmin']), express.json(), controller.seedRb);
router.get('/schemas/rb/extension', authMiddleware(), controller.getExtension);
router.put('/schemas/rb/extension', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), controller.updateExtension);
router.get('/schemas/rb/questions', authMiddleware(), controller.questions);
router.get('/schemas/:id', authMiddleware(), controller.get);
router.put('/schemas/:id', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), controller.update);
router.delete('/schemas/:id', authMiddleware(), requireTenantFeature('customSchemas'), controller.remove);
router.post('/schemas/:id/publish', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), controller.publish);
router.get('/schemas/:id/extension', authMiddleware(), controller.getExtension);
router.put('/schemas/:id/extension', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), controller.updateExtension);
router.get('/schemas/:id/questions', authMiddleware(), controller.questions);

router.put('/:level(sites|zones|exreg)/:entityId/schemas/:schemaId', authMiddleware(), requireTenantFeature('customSchemas'), express.json(), (req, res, next) => {
  req.params.level = req.params.level === 'exreg' ? 'equipment' : req.params.level.replace(/s$/, '');
  return controller.attach(req, res, next);
});
router.delete('/:level(sites|zones|exreg)/:entityId/schemas/:schemaId', authMiddleware(), requireTenantFeature('customSchemas'), (req, res, next) => {
  req.params.level = req.params.level === 'exreg' ? 'equipment' : req.params.level.replace(/s$/, '');
  return controller.detach(req, res, next);
});

module.exports = router;
