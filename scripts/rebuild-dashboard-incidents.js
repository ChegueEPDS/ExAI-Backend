require('dotenv').config();
const mongoose = require('mongoose');
const Equipment = require('../models/dataplate');
const { recomputeEquipmentIncidents } = require('../services/dashboardIncidentService');

function parseTenantArg() {
  const arg = process.argv.find((item) => item.startsWith('--tenant='));
  const value = arg ? arg.slice('--tenant='.length).trim() : '';
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

function parseBatchSize() {
  const arg = process.argv.find((item) => item.startsWith('--batch='));
  const n = arg ? Number(arg.slice('--batch='.length)) : 250;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 250;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10
  });

  const tenantId = parseTenantArg();
  const batchSize = parseBatchSize();
  const filter = tenantId ? { tenantId } : {};
  const cursor = Equipment.find(filter).select('_id tenantId').lean().cursor();

  let currentTenant = null;
  let batch = [];
  let scanned = 0;
  let inserted = 0;
  let deleted = 0;

  async function flush() {
    if (!batch.length || !currentTenant) return;
    const result = await recomputeEquipmentIncidents({ tenantId: currentTenant, equipmentIds: batch });
    inserted += Number(result.inserted || 0);
    deleted += Number(result.deleted || 0);
    console.log(`[dashboard-incident-rebuild] scanned=${scanned} tenant=${currentTenant} batch=${batch.length} deleted=${deleted} inserted=${inserted}`);
    batch = [];
  }

  for await (const equipment of cursor) {
    const eqTenant = equipment.tenantId ? String(equipment.tenantId) : '';
    if (!eqTenant) continue;
    if (currentTenant && eqTenant !== currentTenant) {
      await flush();
    }
    currentTenant = eqTenant;
    batch.push(equipment._id);
    scanned += 1;
    if (batch.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  console.log(`[dashboard-incident-rebuild] done scanned=${scanned} deleted=${deleted} inserted=${inserted}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[dashboard-incident-rebuild] failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
