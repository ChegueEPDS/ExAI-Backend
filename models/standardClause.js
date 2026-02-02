const mongoose = require('mongoose');

const StandardClauseSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    standardRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Standard', required: true, index: true },
    standardId: { type: String, required: true, trim: true, index: true },
    edition: { type: String, default: '', trim: true },

    clauseId: { type: String, required: true, trim: true, index: true }, // e.g. 5.3.2 or chunk-0001
    title: { type: String, default: '', trim: true },
    pageOrLoc: { type: String, default: '' }, // best-effort: "chunk:12" or "page:5"
    quoteId: { type: String, required: true, trim: true, index: true },
    text: { type: String, required: true },

    // Ingestion order for simple neighbor expansion.
    seq: { type: Number, default: 0, index: true },

    extractedEntities: { type: mongoose.Schema.Types.Mixed, default: {} },

    tokens: { type: Number, default: 0 },
    embedding: { type: [Number], default: [] },
  },
  { timestamps: true }
);

StandardClauseSchema.index({ tenantId: 1, standardRef: 1, clauseId: 1 }, { unique: true });
StandardClauseSchema.index({ tenantId: 1, standardId: 1, edition: 1, clauseId: 1 });

module.exports = mongoose.model('StandardClause', StandardClauseSchema);
