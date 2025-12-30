const mongoose = require('mongoose');

const EquipmentDataVersionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    equipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Equipment',
      required: true,
      index: true
    },
    version: { type: Number, required: true },
    changedAt: { type: Date, required: true, index: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: {
      type: String,
      enum: ['create', 'update', 'import'],
      default: 'update'
    },
    changedPaths: { type: [String], default: [] },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    previousVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EquipmentDataVersion',
      default: null
    }
  },
  { timestamps: true }
);

EquipmentDataVersionSchema.index(
  { tenantId: 1, equipmentId: 1, version: 1 },
  { unique: true }
);

module.exports = mongoose.model('EquipmentDataVersion', EquipmentDataVersionSchema);

