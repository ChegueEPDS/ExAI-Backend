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

} = require('../controllers/conversationController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// Define conversation routes
router.post('/new-conversation', authMiddleware(['Admin', 'User']), startNewConversation);
router.post('/chat', authMiddleware(), sendMessage);
router.post('/rate-message', authMiddleware(['Admin', 'User']), rateMessage);
router.post('/save-feedback', authMiddleware(['Admin', 'User']), saveFeedback);
router.delete('/conversation/:threadId', authMiddleware(['Admin', 'User']), deleteConversation);
router.get('/conversations', authMiddleware(['Admin', 'User']), getConversations);
router.post('/aisearch', authMiddleware(), searchAndRespond);

// Korábbi beszélgetés betöltése
router.get('/conversation', authMiddleware(['Admin', 'User']), getConversationById);

module.exports = router;
