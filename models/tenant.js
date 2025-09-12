// models/tenant.js
const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  name: { type: String }, // pl. cégnév vagy "Personal — user@domain"
  type: { type: String, enum: ['company', 'personal'], required: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // personal esetén hasznos
}, { timestamps: true });

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', TenantSchema);