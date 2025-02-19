const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
    azureId: { type: String, unique: true, sparse: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { 
        type: String, 
        required: true, 
        unique: true, 
        match: [/\S+@\S+\.\S+/, 'Please enter a valid email address'] 
    },
    nickname: { type: String, required: false },
    company: { type: String, required: true },
    tenantId: { type: String },
    role: { type: String, required: true, enum: ['Admin', 'User'], default: 'User' },
    password: { type: String, required: function() { return !this.azureId; } }, // Microsoft usernek nem kell
});

// Jelszó hash mentés előtt
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  // Ha a jelszó már bcrypt hash (kezdet "$2b$" vagy "$2a$"), ne hash-eljük újra
  if (this.password.startsWith('$2b$') || this.password.startsWith('$2a$')) {
    return next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);

module.exports = User;