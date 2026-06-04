const mongoose = require('mongoose');

const DashboardIncidentStateSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: true, index: true },
    rebuiltAt: { type: Date, required: true, default: Date.now }
  },
  { timestamps: true }
);

DashboardIncidentStateSchema.index(
  { tenantId: 1, equipmentId: 1 },
  { unique: true, name: 'uniq_dashboard_incident_state_equipment' }
);

module.exports = mongoose.model('DashboardIncidentState', DashboardIncidentStateSchema);
