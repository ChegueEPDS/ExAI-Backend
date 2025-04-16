
const questionsController = require('../controllers/questionsController');
const express = require('express');

const router = express.Router();

router.post('/', questionsController.addQuestion);
router.get('/', questionsController.getQuestions);
router.put('/:id', questionsController.updateQuestion);
router.delete('/:id', questionsController.deleteQuestion);

module.exports = router;