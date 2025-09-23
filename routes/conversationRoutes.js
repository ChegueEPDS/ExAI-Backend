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
router.post('/new-conversation', authMiddleware(), startNewConversation);
router.post('/chat', authMiddleware(), sendMessage);
router.post('/chat/stream', authMiddleware(), require('../controllers/conversationController').sendMessageStream);
router.post('/rate-message', authMiddleware(), rateMessage);
router.post('/save-feedback', authMiddleware(), saveFeedback);
router.delete('/conversation/:threadId', authMiddleware(), deleteConversation);
router.get('/conversations', authMiddleware(), getConversations);
router.post('/aisearch', authMiddleware(), searchAndRespond);

// Korábbi beszélgetés betöltése
router.get('/conversation', authMiddleware(), getConversationById);

router.post(
  '/upload-and-summarize/stream',
  authMiddleware(),
  upload.array('files', 10),
  uploadAndSummarizeStream
);

module.exports = router;
