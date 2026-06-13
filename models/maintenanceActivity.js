const mongoose = require('mongoose');

const MaintenanceActivityAttachmentSchema = new mongoose.Schema(
  {
    blobPath: { type: String, default: '' },
    blobUrl: { type: String, default: '' },
    type: { type: String, enum: ['image', 'document'], default: 'image' },
    contentType: { type: String, default: '' },
    size: { type: Number, default: null },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { _id: false }
);

const MaintenanceActivitySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    schemaId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchemaDefinition', required: true, index: true },
    schemaKeySnapshot: { type: String, default: '' },
    schemaNameSnapshot: { type: String, default: '' },
    occurredAt: { type: Date, required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['completed', 'partial', 'skipped'], default: 'completed', index: true },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
    note: { type: String, default: '' },
    attachments: { type: [MaintenanceActivityAttachmentSchema], default: [] },
    source: { type: String, enum: ['mobile', 'web', 'unknown'], default: 'web', index: true }
  },
  { timestamps: true }
);

MaintenanceActivitySchema.index({ tenantId: 1, equipmentId: 1, occurredAt: -1 });
MaintenanceActivitySchema.index({ tenantId: 1, schemaId: 1, occurredAt: -1 });

MaintenanceActivitySchema.post('save', function scheduleDashboardIncidentRefresh(doc) {
  try {
    if (!doc?.tenantId || !doc?.equipmentId) return;
    require('../services/dashboardIncidentService').scheduleRecomputeEquipmentIncidents({
      tenantId: doc.tenantId,
      equipmentId: doc.equipmentId
    });
  } catch {
    // Best-effort cache refresh; never block maintenance activity writes.
  }
});

module.exports = mongoose.model('MaintenanceActivity', MaintenanceActivitySchema);
