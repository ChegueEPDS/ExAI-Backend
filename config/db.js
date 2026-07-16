const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    const workerOnly = ['1', 'true'].includes(String(process.env.WORKER_ONLY || '').toLowerCase());
    const defaultMaxPoolSize = workerOnly ? 10 : 15;
    const maxPoolSize = Math.max(2, Math.min(Number(process.env.MONGO_MAX_POOL_SIZE || defaultMaxPoolSize), 200));
    const minPoolSize = Math.max(0, Math.min(Number(process.env.MONGO_MIN_POOL_SIZE || 0), maxPoolSize));
    const maxIdleTimeMS = Math.max(30_000, Number(process.env.MONGO_MAX_IDLE_TIME_MS || 120_000));
    const waitQueueTimeoutMS = Math.max(1000, Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS || 30_000));
    const autoIndex = String(process.env.MONGO_AUTO_INDEX ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
    const serverSelectionTimeoutMS = Math.max(5000, Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000));
    const socketTimeoutMS = Math.max(45000, Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120000));
    const heartbeatFrequencyMS = Math.max(10000, Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS || 30000));
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS,
      socketTimeoutMS,
      heartbeatFrequencyMS,
      maxPoolSize,
      minPoolSize,
      maxIdleTimeMS,
      waitQueueTimeoutMS,
      autoIndex,
      appName: workerOnly ? 'exai-worker' : 'exai-api',
    });
    console.log('MongoDB connected OK', {
      role: workerOnly ? 'worker' : 'api',
      maxPoolSize,
      minPoolSize,
      maxIdleTimeMS,
      waitQueueTimeoutMS
    });
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
