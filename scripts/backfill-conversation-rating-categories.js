require('dotenv').config();
const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const { attachAssistantRatingCategory } = require('../services/conversationStatsService');

function parseTenantArg() {
  const arg = process.argv.find((item) => item.startsWith('--tenant='));
  const value = arg ? arg.slice('--tenant='.length).trim() : '';
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10
  });

  const tenantId = parseTenantArg();
  const filter = tenantId ? { tenantId } : {};
  const cursor = Conversation.find(filter).select('messages').cursor();

  let scanned = 0;
  let updated = 0;
  for await (const conversation of cursor) {
    scanned += 1;
    let changed = false;
    const messages = conversation.messages || [];
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant' || msg.rating == null) continue;
      const before = msg.assistantRatingCategory || null;
      const after = attachAssistantRatingCategory(messages, i) || null;
      if (before !== after) changed = true;
    }
    if (changed) {
      await conversation.save();
      updated += 1;
    }
    if (scanned % 500 === 0) {
      console.log(`[conversation-rating-backfill] scanned=${scanned} updated=${updated}`);
    }
  }

  console.log(`[conversation-rating-backfill] done scanned=${scanned} updated=${updated}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[conversation-rating-backfill] failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
