const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    const maxPoolSize = Math.max(10, Math.min(Number(process.env.MONGO_MAX_POOL_SIZE || 30), 200));
    const autoIndex = String(process.env.MONGO_AUTO_INDEX ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
    const serverSelectionTimeoutMS = Math.max(5000, Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000));
    const socketTimeoutMS = Math.max(45000, Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120000));
    const heartbeatFrequencyMS = Math.max(10000, Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS || 30000));
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS,
      socketTimeoutMS,
      heartbeatFrequencyMS,
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
