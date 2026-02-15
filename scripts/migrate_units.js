const mongoose = require('mongoose');

const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
  if (!uri) {
    throw new Error('Missing MONGODB_URI (or MONGO_URI/MONGO_URL) env var');
  }

  await mongoose.connect(uri, { autoIndex: false });

  const unitResult = await Unit.updateMany(
    {
      $or: [
        { parentUnitId: { $exists: false } },
        { ancestors: { $exists: false } },
        { depth: { $exists: false } }
      ]
    },
    {
      $set: { parentUnitId: null, ancestors: [], depth: 0 }
    }
  );

  const equipmentResult = await Equipment.updateMany(
    { Unit: { $exists: false }, Zone: { $exists: true } },
    [{ $set: { Unit: '$Zone' } }]
  );

  console.log('Unit migration completed', {
    unitsMatched: unitResult.matchedCount,
    unitsModified: unitResult.modifiedCount,
    equipmentMatched: equipmentResult.matchedCount,
    equipmentModified: equipmentResult.modifiedCount
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
