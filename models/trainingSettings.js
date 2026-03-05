// models/trainingSettings.js
const mongoose = require('mongoose');

const TrainingSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, unique: true }, // e.g. 'rot'
    templateDocx: {
      originalName: { type: String, default: '', trim: true },
      blobPath: { type: String, default: '', trim: true },
      blobUrl: { type: String, default: '', trim: true }
    },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }
  },
  { timestamps: true }
);

TrainingSettingsSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
  }
});

module.exports = mongoose.model('TrainingSettings', TrainingSettingsSchema);

