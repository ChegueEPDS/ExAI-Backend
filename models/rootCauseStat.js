const mongoose = require('mongoose');

const RootCauseStatSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: false, index: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['maintenance', 'compliance'], required: true, index: true },
    occurredAt: { type: Date, required: true, index: true },
    severity: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null, index: true },
    noteCounts: { type: Map, of: Number, default: {} }
  },
  { timestamps: true }
);

RootCauseStatSchema.index({ tenantId: 1, kind: 1, occurredAt: 1 });
RootCauseStatSchema.index({ tenantId: 1, kind: 1, equipmentId: 1, occurredAt: 1 });
RootCauseStatSchema.index({ kind: 1, sourceId: 1 }, { unique: true });

module.exports = mongoose.model('RootCauseStat', RootCauseStatSchema);
