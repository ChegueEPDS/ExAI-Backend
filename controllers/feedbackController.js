const Conversation = require('../models/conversation');

// Save feedback for a message
exports.saveFeedback = async (req, res) => {
  const { threadId, messageIndex, comment, references } = req.body;

  try {
    const conversation = await Conversation.findOne({ threadId });
    if (!conversation || !conversation.messages[messageIndex]) {
      return res.status(404).json({ error: 'Message not found' });
    }

    conversation.messages[messageIndex].feedback = {
      comment,
      references,
      submittedAt: new Date(),
    };
    await conversation.save();
    res.status(200).json({ message: 'Feedback saved successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save feedback' });
  }
};

// Get all feedback
exports.getAllFeedback = async (req, res) => {
  try {
    const conversations = await Conversation.find();
    const feedbackList = [];

    conversations.forEach((conversation) => {
      let lastUserMessage = '';

      conversation.messages.forEach((message) => {
        if (message.role === 'user') {
          lastUserMessage = message.content;
        }
        if (message.feedback && (message.feedback.comment || message.feedback.references)) {
          feedbackList.push({
            question: lastUserMessage,
            answer: message.content,
            feedback: message.feedback.comment,
            references: message.feedback.references,
            submittedAt: message.feedback.submittedAt,
          });
        }
      });
    });

    res.status(200).json(feedbackList);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve feedback' });
  }
};
