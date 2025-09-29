// models/invite.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const InviteSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  email: { type: String, lowercase: true, trim: true },           // opcionális: előre megcélzott email
  role: { type: String, enum: ['User', 'Admin'], default: 'User' }, // belépéskor adandó szerep (max Admin)
  code: { type: String, unique: true, index: true },              // rövid kód (pl. 8-10 char)
  token: { type: String, unique: true, index: true },             // hosszú token (linkhez)
  expiresAt: { type: Date, required: true },
  maxUses: { type: Number, default: 1, min: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active', index: true }
}, { timestamps: true });

InviteSchema.index({ tenantId: 1, status: 1 });
InviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL a lejáratra

InviteSchema.statics.generateCode = function () {
  return crypto.randomBytes(4).toString('hex'); // 8 hex karakter
};
InviteSchema.statics.generateToken = function () {
  return crypto.randomBytes(24).toString('hex'); // linkhez
};

InviteSchema.methods.isUsable = function () {
  if (this.status !== 'active') return false;
  if (this.expiresAt && this.expiresAt < new Date()) return false;
  if (typeof this.maxUses === 'number' && this.usedCount >= this.maxUses) return false;
  return true;
};

module.exports = mongoose.model('Invite', InviteSchema);