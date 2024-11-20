const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const openAIController = require('../controllers/openaiController');

router.get('/instructions', authMiddleware(['Admin']), openAIController.getAssistantInstructions);

module.exports = router;