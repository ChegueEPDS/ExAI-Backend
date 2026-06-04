const mongoose = require('mongoose');

const DashboardIncidentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    kind: {
      type: String,
      enum: ['maintenance', 'compliance', 'maintenance-schema', 'compliance-schema'],
      required: true,
      index: true
    },
    schemaId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchemaDefinition', default: null, index: true },
    schemaName: { type: String, default: '' },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, default: null, index: true },
    severity: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null, index: true },
    repairs: { type: Number, default: 0 }
  },
  { timestamps: true }
);

DashboardIncidentSchema.index({ tenantId: 1, equipmentId: 1, kind: 1, startAt: 1, _id: 1 });
DashboardIncidentSchema.index({ tenantId: 1, kind: 1, startAt: 1, endAt: 1 });
DashboardIncidentSchema.index({ tenantId: 1, kind: 1, schemaId: 1, startAt: 1 });

module.exports = mongoose.model('DashboardIncident', DashboardIncidentSchema);
