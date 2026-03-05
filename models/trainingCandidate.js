// models/trainingCandidate.js
const mongoose = require('mongoose');

const UnitSelectionSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true }, // 'EX 001'
    scope: { type: String, enum: ['gas', 'dust', 'both'], default: 'both' }
  },
  { _id: false }
);

const TrainingCandidateSchema = new mongoose.Schema(
  {
    trainingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Training', required: true, index: true },
    rowNo: { type: Number, default: null },

    trainingLocation: { type: String, default: '', trim: true },
    givenNames: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    employer: { type: String, default: '', trim: true },
    country: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    passportOrId: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },

    units: { type: [UnitSelectionSchema], default: [] },

    rotDocx: {
      fileName: { type: String, default: '', trim: true },
      blobPath: { type: String, default: '', trim: true },
      blobUrl: { type: String, default: '', trim: true }
    },
    rotMeta: {
      templateUpdatedAt: { type: Date, default: null },
      unitsUpdatedAt: { type: Date, default: null },
      generatedAt: { type: Date, default: null }
    },

    status: { type: String, enum: ['pending', 'generated', 'error'], default: 'pending', index: true },
    error: { type: String, default: '', trim: true }
  },
  { timestamps: true }
);

TrainingCandidateSchema.index({ trainingId: 1, createdAt: -1 });

TrainingCandidateSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
  }
});

module.exports = mongoose.model('TrainingCandidate', TrainingCandidateSchema);
