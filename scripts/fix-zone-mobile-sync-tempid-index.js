require('dotenv').config();
const mongoose = require('mongoose');

const connectDB = require('../config/db');
require('../models/unit');

async function dropIndexIfExists(collection, name) {
  try {
    await collection.dropIndex(name);
    return true;
  } catch (err) {
    if (err?.codeName === 'IndexNotFound' || err?.code === 27) return false;
    throw err;
  }
}

async function main() {
  await connectDB();

  const collection = mongoose.connection.db.collection('zones');
  const before = await collection.indexes();
  const existing = before.find((idx) => idx.name === 'tenantId_1_mobileSync.tempId_1');

  const droppedOldIndex = existing
    ? await dropIndexIfExists(collection, 'tenantId_1_mobileSync.tempId_1')
    : false;

  await collection.createIndex(
    { tenantId: 1, 'mobileSync.tempId': 1 },
    {
      unique: true,
      partialFilterExpression: {
        'mobileSync.tempId': { $type: 'string' }
      },
      name: 'tenantId_1_mobileSync.tempId_1'
    }
  );

  const after = await collection.indexes();
  console.log(JSON.stringify({
    collection: 'zones',
    droppedOldIndex,
    before: existing || null,
    after: after.find((idx) => idx.name === 'tenantId_1_mobileSync.tempId_1') || null
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
