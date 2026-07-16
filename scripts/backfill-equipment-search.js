require('dotenv').config();
const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const { buildEquipmentSearchFields, SEARCHABLE_EQUIPMENT_FIELDS } = require('../helpers/equipmentSearch');

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = Math.min(500, Math.max(10, Number(process.env.EQUIPMENT_SEARCH_BACKFILL_BATCH_SIZE) || 100));

async function main() {
  if (!process.env.MONGO_URI) throw new Error('Missing MONGO_URI');
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 120_000,
    maxPoolSize: 3
  });

  const projection = Object.fromEntries(['_id', ...SEARCHABLE_EQUIPMENT_FIELDS].map((field) => [field, 1]));
  const cursor = Equipment.find({}).select(projection).lean().cursor({ batchSize: BATCH_SIZE });
  let scanned = 0;
  let changed = 0;
  let operations = [];

  const flush = async () => {
    if (!operations.length) return;
    if (APPLY) await Equipment.collection.bulkWrite(operations, { ordered: false });
    operations = [];
  };

  for await (const equipment of cursor) {
    scanned += 1;
    const fields = buildEquipmentSearchFields(equipment);
    operations.push({
      updateOne: {
        filter: { _id: equipment._id },
        update: { $set: fields }
      }
    });
    changed += 1;
    if (operations.length >= BATCH_SIZE) {
      await flush();
      if (scanned % 1000 === 0) console.log(`${APPLY ? 'Updated' : 'Scanned'} ${scanned} equipment documents`);
    }
  }
  await flush();
  console.log(JSON.stringify({ apply: APPLY, scanned, changed, batchSize: BATCH_SIZE }, null, 2));
  if (!APPLY) console.log('Dry run only. Re-run with --apply to persist normalized search fields.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
