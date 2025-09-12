const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  azureId: { type: String, unique: true, sparse: true },
  firstName: { type: String, required: true },
  lastName:  { type: String, required: true },
  email:     { type: String, required: true, unique: true, match: [/\S+@\S+\.\S+/, 'Please enter a valid email address'] },
  nickname:  { type: String },

  // TENANT – átmenetileg required:false, migráció után feltehető required:true
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true, required: false },

  role:      { type: String, enum: ['User', 'Admin', 'SuperAdmin'], default: 'User', required: true },
  password:  { type: String, required: function() { return !this.azureId; } },
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (this.password?.startsWith('$2b$') || this.password?.startsWith('$2a$')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
module.exports = User;