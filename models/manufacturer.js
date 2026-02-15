const mongoose = require('mongoose');

function normalizeManufacturerName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  // NFKD + strip diacritics, unify separators, and keep only alphanumerics.
  const noDiacritics = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return noDiacritics
    .toLowerCase()
    .replace(/&|\+/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const ManufacturerSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

ManufacturerSchema.index({ tenantId: 1, normalizedName: 1 }, { unique: true });

ManufacturerSchema.statics.normalizeName = normalizeManufacturerName;

module.exports = mongoose.model('Manufacturer', ManufacturerSchema);

