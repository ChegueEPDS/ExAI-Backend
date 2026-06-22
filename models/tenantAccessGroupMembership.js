const mongoose = require('mongoose');

const TenantAccessGroupMembershipSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'TenantAccessGroup', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

TenantAccessGroupMembershipSchema.index({ tenantId: 1, groupId: 1, userId: 1 }, { unique: true });
TenantAccessGroupMembershipSchema.index({ tenantId: 1, userId: 1 });

module.exports =
  mongoose.models.TenantAccessGroupMembership ||
  mongoose.model('TenantAccessGroupMembership', TenantAccessGroupMembershipSchema);
