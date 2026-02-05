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
  meta: mongoose.Schema.Types.Mixed, // stores per-message auxiliary info (e.g., chat-with-files context)
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

// ——— Background job állapot a beszélgetéshez kötve ———
const JobSchema = new mongoose.Schema({
  // jelenlegi feladat típusa (később bővíthető)
  type: { type: String, enum: ['upload_and_summarize', 'chat_with_files', 'governed_chat'], required: true },

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

  // Governed RAG: internal project identifier used to scope datasets + Pinecone namespace
  governedProjectId: { type: String, default: null, index: true },

  // Persist which backend should handle follow-up messages for this thread.
  // - normal: /api/chat/stream
  // - governed: /api/chat/governed/stream (Pinecone + tenant standards + project dataset)
  chatBackend: { type: String, enum: ['normal', 'governed'], default: 'normal', index: true },

  // Standard Explorer (tenant library): optional "standards-only" governed chat mode.
  // When enabled, the UI opens the selected standard PDF from Blob and routes messages to governed retrieval,
  // prioritizing this standard but allowing fallback to the full tenant library if needed.
  standardExplorer: {
    enabled: { type: Boolean, default: false, index: true },
    standardRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Standard', default: null, index: true },
  },

  // Persist file-search context for hybrid/sandbox chats
  assistantId:   { type: String, default: null },     // sandbox esetben saját asszisztens
  vectorStoreId: { type: String, default: null },     // sandbox esetben saját store
  mode:          { type: String, enum: ['default','hybrid','sandbox'], default: 'default' },
  fileIds:       { type: [String], default: [] },     // legutóbbi (vagy fixált) fájlok

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
ConversationSchema.index({ mode: 1, updatedAt: -1 });
ConversationSchema.index({ assistantId: 1, updatedAt: -1 });
ConversationSchema.index({ vectorStoreId: 1, updatedAt: -1 });
ConversationSchema.index({ tenantId: 1, mode: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
