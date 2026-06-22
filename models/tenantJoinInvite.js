const mongoose = require('mongoose');

const TenantJoinInviteSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    toTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    invitedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetRole: { type: String, enum: ['User', 'Admin'], default: 'User' },
    professions: {
      type: [{ type: String, enum: ['manager', 'operative', 'ex_inspector', 'technician'] }],
      default: undefined,
    },
    accessGroupIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TenantAccessGroup' }],
      default: undefined,
    },
    tokenHash: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'accepted', 'rejected', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date },
    rejectedAt: { type: Date },
  },
  { timestamps: true }
);

TenantJoinInviteSchema.index(
  { userId: 1, toTenantId: 1, status: 1 },
  { name: 'tenant_join_invite_active_lookup' }
);

module.exports = mongoose.models.TenantJoinInvite || mongoose.model('TenantJoinInvite', TenantJoinInviteSchema);
