//ragChunk.js
const mongoose = require('mongoose');

const RagChunkSchema = new mongoose.Schema({
  threadId: { type: String, index: true, required: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  filename: { type: String, default: '' },
  chunkIndex: { type: Number, default: 0 },
  text: { type: String, default: '' },
  tokens: { type: Number, default: 0 },

  // egyszerű tömbként tároljuk, kérdésnél memóriában számolunk koszinusz hasonlóságot
  embedding: { type: [Number], default: [] },

  createdAt: { type: Date, default: Date.now }
});

RagChunkSchema.index({ threadId: 1, chunkIndex: 1 }, { unique: false });

module.exports = mongoose.model('RagChunk', RagChunkSchema);