const crypto = require('crypto');
const mongoose = require('mongoose');

const ownerId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;

function locksCollection() {
  if (!mongoose.connection?.db) return null;
  return mongoose.connection.db.collection('app_locks');
}

async function withLock(name, ttlMs, fn) {
  const col = locksCollection();
  if (!col) return fn();

  const now = new Date();
  const expiresAt = new Date(Date.now() + Math.max(Number(ttlMs) || 60_000, 10_000));
  let result;
  try {
    result = await col.findOneAndUpdate(
      {
        _id: String(name),
        $or: [
          { expiresAt: { $lte: now } },
          { ownerId }
        ]
      },
      {
        $set: {
          ownerId,
          expiresAt,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      {
        upsert: true,
        returnDocument: 'after'
      }
    );
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }

  const lock = result?.value || result;
  if (!lock || lock.ownerId !== ownerId) return null;

  try {
    return await fn();
  } finally {
    await col.deleteOne({ _id: String(name), ownerId }).catch(() => {});
  }
}

module.exports = { withLock };
