// models/tenant.js
const mongoose = require('mongoose');

const SeatsSchema = new mongoose.Schema(
  {
    max: { type: Number, default: 0, min: 0 },
    used: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator(v) {
          // used nem lehet nagyobb, mint max
          return typeof this.max !== 'number' || v <= this.max;
        },
        message: 'Seats used cannot exceed seats max.',
      },
    },
  },
  { _id: false }
);

const TenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true, // gyors keresés és egyediség
      minlength: 2,
      maxlength: 64,
      match: /^[a-z0-9\-_.]+$/, // egyszerű slug szabály, ha szeretnéd
    },
    type: { type: String, enum: ['personal', 'company'], required: true },
    // regisztrációnál mindig free, csak a Stripe webhook módosíthatja
    plan: { type: String, enum: ['free', 'pro', 'team'], required: true },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Stripe billing
    stripeCustomerId: { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true },

    seats: {
      type: SeatsSchema,
      default: () => ({ max: 0, used: 0 }),
    },

    // hogyan kezeli az üléseket
    seatsManaged: { type: String, enum: ['stripe', 'manual'], default: 'stripe' },
  },
  { timestamps: true }
);

// regisztrációnál plan mindig free, később a Stripe webhook állítja át pro/team-re
// Üzleti szabályok:
// - company → csak team
// - personal → free vagy pro
TenantSchema.pre('validate', function (next) {
  if (this.type === 'company' && this.plan !== 'team') {
    return next(new Error('Company tenant must use the team plan.'));
  }
  if (this.type === 'personal' && !['free', 'pro'].includes(this.plan)) {
    return next(new Error('Personal tenant must use free or pro plan.'));
  }
  next();
});

// Kényelmi virtualok
TenantSchema.virtual('isCompany').get(function () {
  return this.type === 'company';
});
TenantSchema.virtual('isPersonal').get(function () {
  return this.type === 'personal';
});

// Hasznos indexek
TenantSchema.index({ type: 1, plan: 1 });

// JSON kimenet tisztítás
TenantSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
  },
});

module.exports = mongoose.model('Tenant', TenantSchema);
