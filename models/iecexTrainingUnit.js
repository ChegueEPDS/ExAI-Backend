// models/iecexTrainingUnit.js
const mongoose = require('mongoose');

const IecExTrainingUnitSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true }, // e.g. 'EX 001'
    title: { type: String, required: true, trim: true },
    standard: { type: String, default: '', trim: true }, // free text (can contain newlines)
    trainingType: { type: String, default: 'Full', trim: true }, // optional, template uses 'Full'
    active: { type: Boolean, default: true, index: true }
  },
  { timestamps: true }
);

IecExTrainingUnitSchema.index({ code: 1 }, { unique: true });

IecExTrainingUnitSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
  }
});

module.exports = mongoose.model('IecExTrainingUnit', IecExTrainingUnitSchema);

