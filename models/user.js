const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { 
        type: String, 
        required: true, 
        unique: true, 
        match: [/\S+@\S+\.\S+/, 'Please enter a valid email address'] 
    },
    nickname: { type: String, required: false },
    role: { type: String, required: true, enum: ['Admin', 'User'], default: 'User' },
    company: { 
        type: String, 
        required: true, // Állítsd true-ra, ha minden felhasználónak tartoznia kell egy céghez
        enum: ['PGMED', 'Viresol', 'XIII', 'default', 'TUZ', 'STAND98' ], // A támogatott cégazonosítók felsorolása
        default: 'default', // Alapértelmezett érték
    },
    password: { 
        type: String, 
        required: true,
        minlength: [6, 'Password must be at least 6 characters long'] 
    },
});

// Jelszó hash mentés előtt
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const User = mongoose.model('User', UserSchema);

module.exports = User;