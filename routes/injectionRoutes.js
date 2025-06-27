const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const {
  createInjectionRule,
  getAllInjectionRules,
  deleteInjectionRule,
  generateInjectionRule,
  updateInjectionRule,

} = require('../controllers/injectionController');

router.post('/injections', authMiddleware(['Admin']), createInjectionRule);
router.get('/injections', authMiddleware(['Admin']), getAllInjectionRules);
router.delete('/injections/:id', authMiddleware(['Admin']), deleteInjectionRule);
router.post('/injections/generate', authMiddleware(['Admin']), generateInjectionRule);
router.put('/injection-rules/:id', authMiddleware(['Admin']), updateInjectionRule);

module.exports = router;