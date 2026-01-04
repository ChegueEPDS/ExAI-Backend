const mongoose = require('mongoose');

const ProcessingJobSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['mobileSync'], default: 'mobileSync', index: true },
    status: {
      type: String,
      enum: ['queued', 'processing', 'done', 'error'],
      default: 'queued',
      index: true
    },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    equipmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', default: [] }],
    errorItems: [
      {
        equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: false },
        message: { type: String, required: true }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProcessingJob', ProcessingJobSchema);
