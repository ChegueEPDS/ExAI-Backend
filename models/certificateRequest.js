// models/certificateRequest.js
const mongoose = require('mongoose');

const CertificateRequestSchema = new mongoose.Schema(
  {
    // ⚠️ Mindig NORMALIZÁLT cert számot tárolj (pl. "CML 21ATEX1234" → "CML 21-ATEX-1234" / felsőbetű / stb.)
    certNo: { type: String, required: true, index: true },
    manufacturer: { type: String },
    model: { type: String },
    comment: { type: String },

    // Három státusz: open / pending / fulfilled
    status: {
      type: String,
      enum: ['open', 'pending', 'fulfilled'],
      default: 'open',
      index: true
    },

    // Ki kérte
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // (opcionális) melyik tenant alatt jött a kérés
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },

    // Pending státusz nyomkövetése
    pendingAt: { type: Date },
    pendingBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Fulfilled státusz nyomkövetése
    fulfilledByDraftId: { type: mongoose.Schema.Types.ObjectId, ref: 'DraftCertificate' },
    fulfilledCertId: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' },
    fulfilledAt: { type: Date },
    fulfilledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Célszerű egy kompozit index, ha sok query lesz rá:
CertificateRequestSchema.index({ certNo: 1, status: 1 });

module.exports = mongoose.model('CertificateRequest', CertificateRequestSchema);