require('dotenv').config();
const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const Inspection = require('../models/inspection');
const MaintenanceEvent = require('../models/maintenanceEvent');
const { syncConversationStats } = require('../services/conversationStatsService');
const {
  syncInspectionRootCauseStats,
  syncMaintenanceRootCauseStats
} = require('../services/rootCauseStatsService');

function parseTenantArg() {
  const arg = process.argv.find((item) => item.startsWith('--tenant='));
  const value = arg ? arg.slice('--tenant='.length).trim() : '';
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

async function processCursor(label, cursor, handler) {
  let scanned = 0;
  for await (const doc of cursor) {
    await handler(doc);
    scanned += 1;
    if (scanned % 500 === 0) console.log(`[${label}] scanned=${scanned}`);
  }
  console.log(`[${label}] done scanned=${scanned}`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10
  });

  const tenantId = parseTenantArg();
  const tenantFilter = tenantId ? { tenantId } : {};

  await processCursor(
    'conversation-stats-backfill',
    Conversation.find(tenantFilter).select('tenantId threadId messages').cursor(),
    syncConversationStats
  );

  await processCursor(
    'compliance-root-cause-backfill',
    Inspection.find(tenantFilter)
      .select('tenantId equipmentId status reviewStatus results inspectionDate finalizedAt createdAt failureSeverity')
      .cursor(),
    syncInspectionRootCauseStats
  );

  await processCursor(
    'maintenance-root-cause-backfill',
    MaintenanceEvent.find({ ...tenantFilter, kind: 'fault_reported' })
      .select('tenantId equipmentId kind note severity occurredAt createdAt')
      .cursor(),
    syncMaintenanceRootCauseStats
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[dashboard-materialized-stats-backfill] failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
