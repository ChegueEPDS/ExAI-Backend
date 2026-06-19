const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const EquipmentDataVersion = require('../models/equipmentDataVersion');
const {
  isServerNewerThanBase,
  shouldOpenMobileEquipmentConflict
} = require('../services/mobileSyncConflictService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'test' });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await EquipmentDataVersion.deleteMany({});
});

test('isServerNewerThanBase only returns true for a newer server timestamp', () => {
  assert.equal(
    isServerNewerThanBase(
      new Date('2026-06-18T10:00:01.000Z'),
      new Date('2026-06-18T10:00:00.000Z')
    ),
    true
  );
  assert.equal(
    isServerNewerThanBase(
      new Date('2026-06-18T10:00:00.000Z'),
      new Date('2026-06-18T10:00:00.000Z')
    ),
    false
  );
  assert.equal(isServerNewerThanBase(null, new Date()), false);
});

test('shouldOpenMobileEquipmentConflict ignores newer updatedAt without equipment data versions', async () => {
  const tenantId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const baseUpdatedAt = new Date('2026-06-18T10:00:00.000Z');
  const serverUpdatedAt = new Date('2026-06-18T10:05:00.000Z');

  const result = await shouldOpenMobileEquipmentConflict({
    tenantId,
    equipmentId,
    baseUpdatedAt,
    serverUpdatedAt
  });

  assert.equal(result, false);
});

test('shouldOpenMobileEquipmentConflict opens when server data changed after base', async () => {
  const tenantId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const baseUpdatedAt = new Date('2026-06-18T10:00:00.000Z');
  const serverUpdatedAt = new Date('2026-06-18T10:05:00.000Z');

  await EquipmentDataVersion.create({
    tenantId,
    equipmentId,
    version: 1,
    changedAt: new Date('2026-06-18T10:03:00.000Z'),
    changedBy: userId,
    source: 'update',
    changedPaths: ['Manufacturer'],
    snapshot: { Manufacturer: 'New' }
  });

  const result = await shouldOpenMobileEquipmentConflict({
    tenantId,
    equipmentId,
    baseUpdatedAt,
    serverUpdatedAt
  });

  assert.equal(result, true);
});

test('shouldOpenMobileEquipmentConflict ignores data versions at or before base', async () => {
  const tenantId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const baseUpdatedAt = new Date('2026-06-18T10:00:00.000Z');
  const serverUpdatedAt = new Date('2026-06-18T10:05:00.000Z');

  await EquipmentDataVersion.create({
    tenantId,
    equipmentId,
    version: 1,
    changedAt: baseUpdatedAt,
    changedBy: userId,
    source: 'update',
    changedPaths: ['Manufacturer'],
    snapshot: { Manufacturer: 'Old' }
  });

  const result = await shouldOpenMobileEquipmentConflict({
    tenantId,
    equipmentId,
    baseUpdatedAt,
    serverUpdatedAt
  });

  assert.equal(result, false);
});
