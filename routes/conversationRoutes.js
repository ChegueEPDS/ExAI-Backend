//routes/conversationRoutes.js
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
  uploadAndSummarizeStream,
  uploadAndAskStream,
  sendMessageStream,
  chatWithFilesStream
} = require('../controllers/conversationController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const router = express.Router();

// Multer safe wrapper to handle Busboy/Multer errors gracefully
function safeUploadArray(fieldName, maxCount) {
  const mw = upload.array(fieldName, maxCount);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      if (err.name === 'MulterError') {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ message: 'A fájl túl nagy (25MB limit).' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ message: 'Túl sok fájlt választottál (max 10).' });
        }
        return res.status(400).json({ message: `Feltöltési hiba: ${err.code}` });
      }
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('unexpected end of form')) {
        // client aborted upload / connection dropped during multipart
        return res.status(499).json({ message: 'A kapcsolat megszakadt a feltöltés közben. Kérlek próbáld újra.' });
      }
      return next(err);
    });
  };
}

// Define conversation routes
router.post('/new-conversation', authMiddleware(), startNewConversation);
router.post('/chat', authMiddleware(), sendMessage);
router.post('/chat/stream', authMiddleware(), sendMessageStream);
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
  safeUploadArray('files', 10),
  uploadAndSummarizeStream
);

router.post(
  '/upload-and-ask/stream',
  authMiddleware(),
  uploadAndAskStream
);

router.post(
  '/chat/with-files/stream',
  authMiddleware(),
  safeUploadArray('files', 10), // ugyanaz a Busboy/Multer safe wrapper mint máshol
  chatWithFilesStream
);

module.exports = router;
