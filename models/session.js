const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    clientType: { type: String, enum: ['web', 'mobile'], default: 'web', index: true },
    refreshTokenHash: { type: String, required: true, index: true },
    previousRefreshTokenHash: { type: String, default: null, index: true },
    previousRefreshTokenGraceUntil: { type: Date, default: null },
    csrfToken: { type: String, default: null },
    revokedAt: { type: Date, default: null, index: true },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: false, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
