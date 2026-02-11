const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const { authMiddleware } = require('../middlewares/authMiddleware');
const openAIController = require('../controllers/openaiController');

// Vector stores list/create (admin dropdown + provisioning)
router.get('/admin/openai-vector-stores', authMiddleware(['Admin', 'SuperAdmin']), openAIController.listVectorStores);
router.post('/admin/openai-vector-stores', authMiddleware(['Admin', 'SuperAdmin']), openAIController.createVectorStore);

// Read is allowed for any authenticated user (used by chat to fetch persona/model).
router.get('/instructions', authMiddleware(), openAIController.getAssistantInstructions);
// Writes are Admin-only (tenant configuration).
router.put('/instructions', authMiddleware(['Admin', 'SuperAdmin']), openAIController.updateAssistantConfig);

// Vector store management is Admin-only (tenant knowledge base).
router.get('/vector-files', authMiddleware(['Admin', 'SuperAdmin']), openAIController.listAssistantFiles);
router.post('/vector-files', authMiddleware(['Admin', 'SuperAdmin']), upload.single('file'), openAIController.uploadAssistantFile);
router.delete('/vector-files/:fileId', authMiddleware(['Admin', 'SuperAdmin']), openAIController.deleteAssistantFile);

module.exports = router;
