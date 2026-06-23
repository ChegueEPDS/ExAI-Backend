const mongoose = require('mongoose');

const DEFAULT_RETENTION_DAYS = 180;
const retentionDays = Math.max(
  1,
  parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || DEFAULT_RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS
);

const AuditLogSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorEmail: { type: String, lowercase: true, trim: true },
    actorRole: { type: String, enum: ['User', 'Admin', 'SuperAdmin', null], default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },

    action: { type: String, required: true, index: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    routePath: { type: String },
    resourceType: { type: String, index: true },
    resourceId: { type: String },

    statusCode: { type: Number, index: true },
    success: { type: Boolean, index: true },
    requestId: { type: String, index: true },
    clientType: { type: String },
    ipHash: { type: String },
    userAgentHash: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ tenantId: 1, createdAt: -1 });
AuditLogSchema.index({ actorUserId: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
