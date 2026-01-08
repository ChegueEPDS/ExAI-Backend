const mongoose = require('mongoose');

const SyncTombstoneSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    entityType: { type: String, enum: ['site', 'zone', 'equipment'], required: true, index: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    deletedAt: { type: Date, default: Date.now, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    meta: { type: Object, default: {} }
  },
  { timestamps: true }
);

SyncTombstoneSchema.index({ tenantId: 1, entityType: 1, entityId: 1 }, { unique: true });
SyncTombstoneSchema.index({ tenantId: 1, entityType: 1, deletedAt: -1 });

module.exports = mongoose.model('SyncTombstone', SyncTombstoneSchema);

