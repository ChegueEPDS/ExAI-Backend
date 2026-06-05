const mongoose = require('mongoose');

const MaintenanceEventSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },

    kind: {
      type: String,
      enum: ['fault_reported', 'repair_started', 'repair_completed'],
      required: true,
      index: true
    },

    occurredAt: { type: Date, required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    note: { type: String, default: '' },

    // For fault_reported
    severity: {
      type: String,
      enum: ['P1', 'P2', 'P3', 'P4', null],
      default: null,
      index: true
    },

    // Link repair lifecycle events together
    repairId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Idempotency for external/system-created events such as mobile sync retries.
    source: { type: String, default: null, index: true },
    sourceId: { type: String, default: null, index: true },

    // For repair_completed
    completedWorking: { type: Boolean, default: null }
  },
  { timestamps: true }
);

MaintenanceEventSchema.index({ tenantId: 1, equipmentId: 1, occurredAt: -1 });
MaintenanceEventSchema.index({ tenantId: 1, equipmentId: 1, kind: 1, occurredAt: -1 });
MaintenanceEventSchema.index({ tenantId: 1, source: 1, sourceId: 1, kind: 1 });

MaintenanceEventSchema.post('save', function scheduleDashboardIncidentRefresh(doc) {
  try {
    if (!doc?.tenantId || !doc?.equipmentId) return;
    require('../services/dashboardIncidentService').scheduleRecomputeEquipmentIncidents({
      tenantId: doc.tenantId,
      equipmentId: doc.equipmentId
    });
  } catch {
    // Best-effort cache refresh; never block maintenance writes.
  }
  try {
    require('../services/rootCauseStatsService').syncMaintenanceRootCauseStats(doc).catch(() => {});
  } catch {
    // Best-effort stats mirror; never block maintenance writes.
  }
});

module.exports = mongoose.model('MaintenanceEvent', MaintenanceEventSchema);
