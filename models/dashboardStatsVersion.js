const mongoose = require('mongoose');

const DashboardStatsVersionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    version: { type: Number, default: 0, index: true },
    updatedAt: { type: Date, default: Date.now },
    reason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DashboardStatsVersion', DashboardStatsVersionSchema);
