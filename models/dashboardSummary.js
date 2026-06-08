const mongoose = require('mongoose');

const DashboardSummarySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    kind: { type: String, required: true, index: true },
    scopeType: {
      type: String,
      enum: ['tenant', 'site', 'zone'],
      required: true,
      index: true
    },
    scopeId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    paramsHash: { type: String, default: '', index: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    sourceVersion: { type: Number, default: 0, index: true },
    status: {
      type: String,
      enum: ['fresh', 'dirty', 'rebuilding', 'failed'],
      default: 'fresh',
      index: true
    },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    calculatedAt: { type: Date, default: null },
    dirtyAt: { type: Date, default: null },
    dirtyReason: { type: String, default: '' },
    rebuildStartedAt: { type: Date, default: null },
    rebuildFinishedAt: { type: Date, default: null },
    errorMessage: { type: String, default: '' }
  },
  { timestamps: true }
);

DashboardSummarySchema.index({ tenantId: 1, kind: 1, scopeType: 1, scopeId: 1, paramsHash: 1 });
DashboardSummarySchema.index({ tenantId: 1, status: 1, dirtyAt: 1 });
DashboardSummarySchema.index({ tenantId: 1, kind: 1, sourceVersion: 1 });

module.exports = mongoose.model('DashboardSummary', DashboardSummarySchema);
