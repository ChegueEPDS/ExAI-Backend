const mongoose = require('mongoose');

// Üzenet séma
const MessageSchema = new mongoose.Schema({
  role: String,
  content: String,
  category: String,
  arrivedAt: { type: Date, default: Date.now },
  inputToken: { type: Number, default: null },
  outputToken: { type: Number, default: null },
  rating: { type: Number, default: null },
  images: { type: [String], default: [] }, 
  feedback: {
    comment: { type: String, default: '' },
    references: { type: String, default: '' },
    submittedAt: { type: Date, default: null }
  }
});

// Beszélgetés séma
const ConversationSchema = new mongoose.Schema({
  threadId: String,
  messages: [MessageSchema],
  userId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date, default: Date.now, },
});

// Ellenőrizzük, hogy a modell már létezik-e
const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);

module.exports = Conversation;
