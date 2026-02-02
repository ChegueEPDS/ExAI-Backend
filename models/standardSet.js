const mongoose = require('mongoose');

const StandardSetSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, index: true }, // e.g. "IECEx_GAS_CORE"
    name: { type: String, required: true, trim: true },
    modeHint: { type: String, enum: ['gas', 'dust', 'both', 'unknown'], default: 'unknown', index: true },
    standardRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Standard', default: [] }],
    aliases: { type: [String], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

StandardSetSchema.index({ tenantId: 1, key: 1 }, { unique: true });
StandardSetSchema.index({ tenantId: 1, updatedAt: -1 });

module.exports = mongoose.model('StandardSet', StandardSetSchema);

