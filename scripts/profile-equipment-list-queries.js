require('dotenv').config();
const { mongo: { MongoClient, ObjectId } } = require('mongoose');

function executionStats(explain) {
  const stats = explain?.executionStats || explain?.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats || {};
  const docs = Number(stats.totalDocsExamined ?? stats.totalDocumentsExamined ?? 0);
  const keys = Number(stats.totalKeysExamined ?? 0);
  const returned = Number(stats.nReturned ?? 0);
  return {
    executionTimeMs: Number(stats.executionTimeMillis ?? stats.executionTimeMillisEstimate ?? 0),
    documentsExamined: docs,
    keysExamined: keys,
    returned,
    scanRatio: returned > 0 ? Number((docs / returned).toFixed(2)) : docs
  };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('Missing MONGO_URI');
  if (!ObjectId.isValid(process.env.PROFILE_TENANT_ID || '')) {
    throw new Error('Set PROFILE_TENANT_ID to the tenant ObjectId to profile.');
  }

  const client = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const collection = client.db().collection('equipment');
    const tenantId = new ObjectId(process.env.PROFILE_TENANT_ID);
    const scenarios = [
      {
        name: 'global-default-order',
        filter: { tenantId, isProcessed: { $ne: false } },
        sort: { orderIndex: 1, _id: 1 }
      },
      {
        name: 'global-tag-sort',
        filter: { tenantId, isProcessed: { $ne: false } },
        sort: { TagNo: 1, _id: 1 }
      },
      {
        name: 'global-updated-sort',
        filter: { tenantId, isProcessed: { $ne: false } },
        sort: { updatedAt: -1, _id: 1 }
      }
    ];

    if (ObjectId.isValid(process.env.PROFILE_SITE_ID || '')) {
      scenarios.push({
        name: 'site-default-order',
        filter: { tenantId, Site: new ObjectId(process.env.PROFILE_SITE_ID), isProcessed: { $ne: false } },
        sort: { orderIndex: 1, _id: 1 }
      });
    }
    if (ObjectId.isValid(process.env.PROFILE_ZONE_ID || '')) {
      const zoneId = new ObjectId(process.env.PROFILE_ZONE_ID);
      scenarios.push({
        name: 'zone-default-order',
        filter: { tenantId, $or: [{ Unit: zoneId }, { Zone: zoneId }], isProcessed: { $ne: false } },
        sort: { orderIndex: 1, _id: 1 }
      });
    }

    const output = [];
    for (const scenario of scenarios) {
      try {
        const explain = await collection.find(scenario.filter).sort(scenario.sort).limit(100).explain('executionStats');
        output.push({ name: scenario.name, ...executionStats(explain) });
      } catch (error) {
        output.push({ name: scenario.name, unsupported: true, error: error.message || String(error) });
      }
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
