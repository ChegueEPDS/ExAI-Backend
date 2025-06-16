const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const authMiddleware = require('../middlewares/authMiddleware');
const openAIController = require('../controllers/openaiController');

router.get('/instructions', authMiddleware(), openAIController.getAssistantInstructions);
router.get('/vector-files', authMiddleware(), openAIController.listAssistantFiles);
router.post('/vector-files', authMiddleware(), upload.single('file'), openAIController.uploadAssistantFile);
router.delete('/vector-files/:fileId', authMiddleware(), openAIController.deleteAssistantFile);

module.exports = router;