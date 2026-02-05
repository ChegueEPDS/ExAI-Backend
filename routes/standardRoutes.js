const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/standardLibraryController');

const router = express.Router();

// Tenant-wide standard library
router.get('/standards', requireAuth, ctrl.listStandards);
router.get('/standards/:standardRef', requireAuth, ctrl.getStandard);
router.get('/standards/:standardRef/pdf', requireAuth, ctrl.getStandardPdfUrl);
router.get('/standards/:standardRef/clauses', requireAuth, ctrl.listStandardClauses);
router.post('/standards/upload', requireAuth, ...ctrl.uploadStandard);
router.delete('/standards/:standardRef', requireAuth, ctrl.deleteStandard);

// Standard sets (bundles)
router.get('/standard-sets', requireAuth, ctrl.listStandardSets);
router.post('/standard-sets', requireAuth, ctrl.createStandardSet);
router.delete('/standard-sets/:setId', requireAuth, ctrl.deleteStandardSet);

module.exports = router;
