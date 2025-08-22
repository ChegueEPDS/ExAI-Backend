const express = require('express');
const { 
  startNewConversation, 
  sendMessage, 
  rateMessage, 
  saveFeedback, 
  deleteConversation,
  getConversations,
  getConversationById,
  searchAndRespond,
  uploadAndSummarizeStream
} = require('../controllers/conversationController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

// Define conversation routes
router.post('/new-conversation', authMiddleware(['Admin', 'User']), startNewConversation);
router.post('/chat', authMiddleware(), sendMessage);
router.post('/chat/stream', authMiddleware(), require('../controllers/conversationController').sendMessageStream);
router.post('/rate-message', authMiddleware(['Admin', 'User']), rateMessage);
router.post('/save-feedback', authMiddleware(['Admin', 'User']), saveFeedback);
router.delete('/conversation/:threadId', authMiddleware(['Admin', 'User']), deleteConversation);
router.get('/conversations', authMiddleware(['Admin', 'User']), getConversations);
router.post('/aisearch', authMiddleware(), searchAndRespond);

// Korábbi beszélgetés betöltése
router.get('/conversation', authMiddleware(['Admin', 'User']), getConversationById);

router.post(
  '/upload-and-summarize/stream',
  authMiddleware(),
  upload.array('files', 10),
  uploadAndSummarizeStream
);

module.exports = router;
