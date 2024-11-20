const express = require('express');
const { saveFeedback, getAllFeedback } = require('../controllers/feedbackController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// Save feedback for a message
router.post('/feedback', authMiddleware(['Admin', 'User']), saveFeedback);

// Get all feedback (Admin only)
router.get('/feedback', authMiddleware(['Admin']), getAllFeedback);

module.exports = router;
