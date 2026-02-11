const mongoose = require('mongoose');

const TenantSettingSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true, trim: true },
    key: { type: String, required: true, trim: true },
    // Tenant-scoped setting value. Stored as JSON-serializable value.
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: String, default: null }, // userId (string) best-effort
  },
  { timestamps: true }
);

TenantSettingSchema.index({ tenantId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('TenantSetting', TenantSettingSchema);

