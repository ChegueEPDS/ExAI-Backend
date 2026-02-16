const mongoose = require('mongoose');

function normalizeUnitNameKey(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const noDiacritics = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return noDiacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const UnitSchema = new mongoose.Schema(
  {
    Name: { type: String, required: true },
    nameKey: { type: String, index: true },
    Description: { type: String },
    Environment: {
      type: String,
      required: true,
      enum: ['Gas', 'Dust', 'Hybrid', 'NonEx']
    },
    Scheme: {
      type: String,
      enum: ['ATEX', 'IECEx', 'NA'],
      default: 'ATEX'
    },
    Zone: {
      type: [Number],
      enum: [0, 1, 2, 20, 21, 22],
      default: []
    },
    SubGroup: {
      type: [String],
      enum: ['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC'],
      default: []
    },
    SkidID: { type: String, trim: true },
    SkidDescription: { type: String },
    ProjectID: { type: String, trim: true },
    TempClass: {
      type: String,
      enum: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
    },
    MaxTemp: { type: Number },
    IpRating: { type: String },
    EPL: {
      type: [String],
      enum: ['Ga', 'Gb', 'Gc', 'Da', 'Db', 'Dc'],
      default: []
    },
    AmbientTempMin: { type: Number },
    AmbientTempMax: { type: Number },
    CreatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    ModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    Site: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Site',
    },
    parentUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Unit',
      default: null,
      index: true
    },
    ancestors: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      index: true
    },
    depth: {
      type: Number,
      default: 0
    },
    mobileSync: {
      tempId: { type: String, trim: true },
      deviceId: { type: String, trim: true },
      createdAt: { type: Date }
    },
    documents: [
      {
        name: { type: String },
        alias: { type: String },
        type: { type: String, enum: ['document', 'image'], default: 'document' },
        uploadedAt: { type: Date, default: Date.now },
        blobPath: { type: String },
        blobUrl: { type: String },
        contentType: { type: String },
        size: { type: Number }
      }
    ],
    clientReq: [
      {
        Zone: {
          type: [Number],
          enum: [0, 1, 2, 20, 21, 22],
          default: []
        },
        SubGroup: {
          type: [String],
          enum: ['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC'],
          default: []
        },
        TempClass: {
          type: String,
          enum: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
        },
        MaxTemp: { type: Number },
        IpRating: { type: String },
        EPL: {
          type: [String],
          enum: ['Ga', 'Gb', 'Gc', 'Da', 'Db', 'Dc'],
          default: []
        },
        AmbientTempMin: { type: Number },
        AmbientTempMax: { type: Number },
      }
    ]
  },
  { timestamps: true, collection: 'zones' }
);

UnitSchema.pre('validate', function (next) {
  try {
    if (this.isNew || this.isModified('Name')) {
      this.nameKey = normalizeUnitNameKey(this.Name);
    }
    next();
  } catch (e) {
    next(e);
  }
});

UnitSchema.pre('save', async function (next) {
  try {
    const user = await mongoose.model('User').findById(this.CreatedBy).select('tenantId');
    if (!user) return next(new Error('Érvénytelen CreatedBy felhasználó.'));

    if (!this.tenantId && user.tenantId) {
      this.tenantId = user.tenantId;
    }
    next();
  } catch (error) {
    return next(error);
  }
});

UnitSchema.pre('findOneAndUpdate', async function (next) {
  const update = this.getUpdate();
  if (!update) return next();

  const nextUpdate = { ...update };
  const set = { ...(nextUpdate.$set || {}) };

  const nextName = set.Name ?? nextUpdate.Name;
  if (nextName !== undefined) {
    set.nameKey = normalizeUnitNameKey(nextName);
  }

  nextUpdate.$set = set;
  this.setUpdate(nextUpdate);

  next();
});

UnitSchema.index({ tenantId: 1, Site: 1, parentUnitId: 1 });
UnitSchema.index({ tenantId: 1, Site: 1, ancestors: 1 });
UnitSchema.index({ tenantId: 1, 'mobileSync.tempId': 1 }, { unique: true, sparse: true });
UnitSchema.index(
  { tenantId: 1, Site: 1, parentUnitId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { nameKey: { $type: 'string' } } }
);

UnitSchema.statics.normalizeNameKey = normalizeUnitNameKey;

module.exports = mongoose.model('Unit', UnitSchema);
