// models/training.js
const mongoose = require('mongoose');

const TrainingSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    folderName: { type: String, required: true, trim: true, maxlength: 240 }, // sanitized for blob path

    dateOfIssue: { type: String, required: true, trim: true }, // 'YYYY-MM-DD'
    validityFrom: { type: String, required: true, trim: true }, // 'YYYY-MM-DD'
    validityTo: { type: String, required: true, trim: true }, // 'YYYY-MM-DD'
    recordOfTrainingNo: { type: String, required: true, trim: true },
    trainingLanguage: { type: String, default: 'English', trim: true },

    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    closedAt: { type: Date, default: null },
    closedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    finalModules: { type: [String], default: [] }, // snapshot at close time, e.g. ['EX 001','EX 010(gas)']
    finalPdf: {
      fileName: { type: String, default: '', trim: true },
      blobPath: { type: String, default: '', trim: true },
      blobUrl: { type: String, default: '', trim: true },
      generatedAt: { type: Date, default: null }
    },

    sourceXlsx: {
      originalName: { type: String, default: '', trim: true },
      blobPath: { type: String, default: '', trim: true },
      blobUrl: { type: String, default: '', trim: true }
    },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    createdByTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true }
  },
  { timestamps: true }
);

TrainingSchema.index({ createdAt: -1 });
TrainingSchema.index({ folderName: 1 }, { unique: true });
TrainingSchema.index({ status: 1, closedAt: -1 });

TrainingSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
  }
});

module.exports = mongoose.model('Training', TrainingSchema);
