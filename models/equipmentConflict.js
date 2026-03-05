const mongoose = require('mongoose');

const EquipmentConflictSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null, index: true },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientTempId: { type: String, default: null, index: true },
    baseUpdatedAt: { type: Date, default: null },
    clientUpdatedAt: { type: Date, default: null },
    // Only the changed fields from the client (diff-like payload).
    clientChanges: { type: Object, default: {} },
    // Full server snapshot at time of conflict for merge context.
    serverSnapshot: { type: Object, default: {} },
    // Files uploaded by the client during a sync that resulted in a conflict.
    // These are persisted so images are not lost while waiting for manual resolution.
    clientDocuments: {
      type: [
        {
          name: { type: String },
          alias: { type: String, default: '' },
          type: { type: String, enum: ['document', 'image'], default: 'image' },
          blobPath: { type: String },
          blobUrl: { type: String },
          contentType: { type: String },
          size: { type: Number },
          uploadedAt: { type: Date, default: Date.now },
          tag: { type: String, enum: ['dataplate', 'general', 'fault'], default: 'general' }
        }
      ],
      default: []
    },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolution: { type: Object, default: {} }
  },
  { timestamps: true }
);

EquipmentConflictSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
EquipmentConflictSchema.index({ tenantId: 1, clientTempId: 1 }, { unique: false });

module.exports = mongoose.model('EquipmentConflict', EquipmentConflictSchema);
