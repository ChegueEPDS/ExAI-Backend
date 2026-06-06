const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    const maxPoolSize = Math.max(10, Math.min(Number(process.env.MONGO_MAX_POOL_SIZE || 30), 200));
    const autoIndex = String(process.env.MONGO_AUTO_INDEX ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize,
      autoIndex,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
