require('dotenv').config();
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const SchemaDefinition = require('../models/schemaDefinition');

async function dropOldSystemKeyIndex(collection) {
  try {
    await collection.dropIndex('uniq_system_schema_key');
    return true;
  } catch (err) {
    if (err?.codeName === 'IndexNotFound' || err?.code === 27) return false;
    throw err;
  }
}

async function main() {
  await connectDB();

  const collection = SchemaDefinition.collection;
  const droppedOldIndex = await dropOldSystemKeyIndex(collection);
  await collection.createIndex(
    { systemKey: 1 },
    {
      unique: true,
      partialFilterExpression: { scope: 'system' },
      name: 'uniq_system_schema_key'
    }
  );

  const indexes = await collection.indexes();
  console.log(JSON.stringify({
    droppedOldIndex,
    systemKeyIndex: indexes.find((idx) => idx.name === 'uniq_system_schema_key') || null
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
