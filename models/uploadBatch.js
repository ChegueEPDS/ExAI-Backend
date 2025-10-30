// models/uploadBatch.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const UploadBatchSchema = new Schema(
  {
    uploadId:   { type: String, required: true, unique: true, index: true },
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // számlálók (controller így hivatkozik rájuk)
    total:      { type: Number, required: true, default: 0 },
    saved:      { type: Number, required: true, default: 0 },
    discarded:  { type: Number, required: true, default: 0 },

    // levélküldés állapota
    notified:   { type: Boolean, default: false },
    completedAt:{ type: Date, default: null },

    createdAt:  { type: Date, default: Date.now }
  },
  { versionKey: false }
);

// gyors listázáshoz
UploadBatchSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('UploadBatch', UploadBatchSchema);