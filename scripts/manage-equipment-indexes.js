require('dotenv').config();
const { mongo: { MongoClient } } = require('mongoose');

const APPLY = process.argv.includes('--apply');
const INDEXES = [
  {
    name: 'tenant_search_trigrams',
    key: { tenantId: 1, searchTrigrams: 1 },
    reason: 'Normalized substring search candidate narrowing.'
  }
];

async function main() {
  if (!process.env.MONGO_URI) throw new Error('Missing MONGO_URI');
  const client = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const collection = client.db().collection('equipment');
    const existing = await collection.indexes();
    const existingNames = new Set(existing.map((index) => index.name));
    for (const index of INDEXES) {
      if (existingNames.has(index.name)) {
        console.log(`[exists] ${index.name} ${JSON.stringify(index.key)}`);
      } else if (APPLY) {
        await collection.createIndex(index.key, { name: index.name });
        console.log(`[created] ${index.name} ${JSON.stringify(index.key)}`);
      } else {
        console.log(`[planned] ${index.name} ${JSON.stringify(index.key)} - ${index.reason}`);
      }
    }
    if (!APPLY) console.log('Dry run only. Re-run with --apply during a controlled deployment window.');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
