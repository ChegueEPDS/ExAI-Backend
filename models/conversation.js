const mongoose = require('mongoose');

// ——— Messages (meglévő logika kompatibilis) ———
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, default: '' },
  images: [{ type: String }],
  rating: { type: Number, min: 1, max: 5 },
  category: { type: String },
  feedback: {
    comment: { type: String, default: null },
    references: { type: String, default: null },
    submittedAt: { type: Date, default: null },
  },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

// ——— Background job állapot a beszélgetéshez kötve ———
const JobSchema = new mongoose.Schema({
  // jelenlegi feladat típusa (később bővíthető)
  type: { type: String, enum: ['upload_and_summarize'], required: true },

  // fő állapot
  status: {
    type: String,
    enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
    default: 'queued',
    index: true,
  },

  // finom státusz (SSE stage-ek tükre)
  stage: { type: String, default: '' },

  // progressz számlálók
  progress: {
    filesTotal: { type: Number, default: 0 },
    filesProcessed: { type: Number, default: 0 },
    chunksTotal: { type: Number, default: 0 },
    chunksCompleted: { type: Number, default: 0 },
    tokensUsed: { type: Number, default: 0 },
    tokenBudget: { type: Number, default: 0 },
    lastMessage: { type: String, default: '' }, // pl. "Reading file: X.pdf"
  },

  // kiegészítő meta
  meta: {
    assistantId: { type: String },
    threadId: { type: String },         // redundáns, de kényelmes
    files: [{ name: String, size: Number, mimetype: String }],
    totalChars: { type: Number, default: 0 },
  },

  // hiba adatok
  error: {
    message: String,
    code: String,
    raw: mongoose.Schema.Types.Mixed,
  },

  startedAt: Date,
  finishedAt: Date,
  updatedAt: { type: Date, default: Date.now },
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
  threadId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  title: { type: String },

  messages: { type: [MessageSchema], default: [] },

  // háttérfeladat a beszélgetéshez rögzítve (1 konverzáció = 1 task egyszerre)
  job: { type: JobSchema, default: null },

  // gyors jelző a listáknak
  hasBackgroundJob: { type: Boolean, default: false },
}, { timestamps: true });

// hasznos indexek a listázáshoz és rendezéshez
ConversationSchema.index({ userId: 1, 'job.status': 1, updatedAt: -1 });
ConversationSchema.index({ createdAt: -1 });
ConversationSchema.index({ tenantId: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', ConversationSchema);