const mongoose = require('mongoose');

const SystemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },
    // Global setting (applies to all tenants). Stored as JSON-serializable value.
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: String, default: null }, // userId (string) best-effort
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemSetting', SystemSettingSchema);

