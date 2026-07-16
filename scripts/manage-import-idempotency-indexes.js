#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');

const apply = process.argv.includes('--apply');

async function ensureIndex(collection, keys, options) {
  const indexes = await collection.indexes();
  const existing = indexes.find((index) => index.name === options.name);
  if (existing) {
    console.log(`[exists] ${collection.collectionName}.${options.name}`);
    return;
  }
  if (!apply) {
    console.log(`[dry-run] create ${collection.collectionName}.${options.name}`, keys);
    return;
  }
  await collection.createIndex(keys, options);
  console.log(`[created] ${collection.collectionName}.${options.name}`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
  await ensureIndex(
    mongoose.connection.collection('equipment'),
    { tenantId: 1, 'importMeta.jobId': 1, 'importMeta.rowKey': 1 },
    {
      unique: true,
      partialFilterExpression: {
        'importMeta.jobId': { $type: 'string' },
        'importMeta.rowKey': { $type: 'string' }
      },
      name: 'uniq_equipment_import_row'
    }
  );
  await ensureIndex(
    mongoose.connection.collection('inspections'),
    { tenantId: 1, importKey: 1 },
    {
      unique: true,
      partialFilterExpression: { importKey: { $type: 'string' } },
      name: 'uniq_inspection_import_key'
    }
  );
  await ensureIndex(
    mongoose.connection.collection('equipmentimportjobs'),
    { tenantId: 1, zoneId: 1, sourceHash: 1, status: 1 },
    {
      partialFilterExpression: { sourceHash: { $type: 'string' } },
      name: 'equipment_import_source_guard'
    }
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
