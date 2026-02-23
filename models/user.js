// models/user.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const PROFESSIONS = Object.freeze([
  'manager',
  'operative',
  'ex_inspector',
  'technician',
]);

const UserSchema = new mongoose.Schema(
  {
    azureId: { type: String, unique: true, sparse: true },

    firstName: { type: String, required: true },
    lastName:  { type: String, required: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true, // 🔹 konszolidált egyediség
      match: [/\S+@\S+\.\S+/, 'Please enter a valid email address']
    },

    nickname:  { type: String },

    // TENANT – migráció után akár required: true
    tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true, required: false },


    role:      { type: String, enum: ['User', 'Admin', 'SuperAdmin'], default: 'User', required: true },

    // App-level RBAC (multi-role). If empty/missing, backend treats it as ['manager'] for backward compatibility.
    professions: {
      type: [{ type: String, enum: PROFESSIONS }],
      default: undefined,
      index: true,
    },

    password:  {
      type: String,
      required: function () { return !this.azureId; } // MS usernél nem kötelező
    },
    position:  { type: String },
    positionInfo: { type: String },
    uiScale: { type: Number, enum: [0.8, 1], default: 0.8 },
    // Optional inspector signature stored in Azure Blob Storage
    signatureBlobPath: { type: String },
    signatureBlobUrl: { type: String },

    emailVerified: { type: Boolean, default: true },
    emailVerificationToken: { type: String },
    emailVerificationExpires: { type: Date },

    // Opcionális: regisztrációkor kiválasztott fizetős csomag (másik böngésző/tab esetén is)
    pendingCheckoutPlan: { type: String }, // 'pro' | 'team' | 'pro_yearly' | 'team_yearly'
    pendingCheckoutSeats: { type: Number },
    pendingCheckoutCompanyName: { type: String },
  },
  { timestamps: true }
);

// Hash csak akkor, ha változott és nem tűnik már hash-nek
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (!this.password) return next();
  if (this.password.startsWith('$2b$') || this.password.startsWith('$2a$')) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Ne szivárogjon a jelszó JSON-kimenetben
UserSchema.methods.toJSON = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  return obj;
};

// --- Virtuals ---
// Link to tenant for easy populate
UserSchema.virtual('tenant', {
  ref: 'Tenant',
  localField: 'tenantId',
  foreignField: '_id',
  justOne: true,
});

// Derive subscription tier from the linked tenant's plan (fallback: 'free')
UserSchema.virtual('subscriptionTier').get(function () {
  // If tenant is populated and has a plan, mirror it
  if (this.populated && typeof this.populated === 'function' && this.populated('tenant')) {
    return (this.tenant && this.tenant.plan) ? this.tenant.plan : 'free';
  }
  // If raw doc already embedded tenant (lean queries, aggregations)
  if (this.tenant && this.tenant.plan) {
    return this.tenant.plan;
  }
  // Fallback when not populated: UI/consumers should rely on tenant.plan via populate
  return 'free';
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
module.exports = User;
