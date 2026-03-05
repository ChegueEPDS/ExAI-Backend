// models/trainingRecordCounter.js
const mongoose = require('mongoose');

/**
 * Per-tenant per-year monotonically increasing counter to generate
 * unique "Record of Training No." values.
 *
 * tenantKey is a string to avoid reliance on ObjectId validity in JWTs.
 */
const TrainingRecordCounterSchema = new mongoose.Schema(
  {
    tenantKey: { type: String, required: true, trim: true, index: true },
    year: { type: Number, required: true, index: true }, // full year, e.g. 2026
    lastSeq: { type: Number, required: true, default: 0 }
  },
  { timestamps: true }
);

TrainingRecordCounterSchema.index({ tenantKey: 1, year: 1 }, { unique: true });

TrainingRecordCounterSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
  }
});

module.exports = mongoose.model('TrainingRecordCounter', TrainingRecordCounterSchema);

