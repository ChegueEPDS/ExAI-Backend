require('dotenv').config();
const mongoose = require('mongoose');

const WARN_AT = Number(process.env.DOCUMENTDB_INDEX_WARN_AT || 56);

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('Missing MONGO_URI');
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 5,
  });

  const collections = await mongoose.connection.db.listCollections().toArray();
  const rows = [];
  for (const c of collections) {
    const indexes = await mongoose.connection.db.collection(c.name).indexes();
    rows.push({
      collection: c.name,
      count: indexes.length,
      warning: indexes.length >= WARN_AT ? 'CHECK_LIMIT' : '',
      indexes: indexes.map((idx) => ({
        name: idx.name,
        key: idx.key,
        unique: Boolean(idx.unique),
        sparse: Boolean(idx.sparse),
      })),
    });
  }

  rows.sort((a, b) => b.count - a.count || a.collection.localeCompare(b.collection));
  for (const row of rows) {
    console.log(`${row.warning ? '[WARN] ' : ''}${row.collection}: ${row.count} indexes`);
    for (const idx of row.indexes) {
      const flags = [idx.unique ? 'unique' : '', idx.sparse ? 'sparse' : ''].filter(Boolean).join(',');
      console.log(`  - ${idx.name} ${JSON.stringify(idx.key)}${flags ? ` (${flags})` : ''}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
