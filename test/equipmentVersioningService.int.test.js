const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const EquipmentDataVersion = require('../models/equipmentDataVersion');
const { createEquipmentDataVersion, computeChangedPaths } = require('../services/equipmentVersioningService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'test' });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test('computeChangedPaths ignores versioning metadata keys', () => {
  const oldSnap = {
    Name: 'A',
    CreatedBy: 'u1',
    ModifiedBy: 'u2',
    tenantId: 't1',
    Pictures: [{ a: 1 }]
  };
  const newSnap = {
    Name: 'B',
    CreatedBy: 'u3',
    tenantId: 't2',
    Pictures: [{ a: 2 }]
  };

  assert.deepEqual(computeChangedPaths(oldSnap, newSnap), ['Name']);
});

test('createEquipmentDataVersion creates baseline on first update', async () => {
  await EquipmentDataVersion.deleteMany({});

  const tenantId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  const oldSnapshot = {
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    CreatedBy: userId,
    Name: 'Old'
  };

  const newSnapshot = {
    ...oldSnapshot,
    Name: 'New'
  };

  const version1 = await createEquipmentDataVersion({
    tenantId,
    equipmentId,
    changedBy: userId,
    source: 'update',
    oldSnapshot,
    newSnapshot,
    ensureBaseline: true
  });

  assert.ok(version1);
  assert.equal(version1.version, 1);
  assert.deepEqual(version1.changedPaths, ['Name']);

  const all = await EquipmentDataVersion.find({ tenantId, equipmentId }).sort({ version: 1 }).lean();
  assert.equal(all.length, 2);
  assert.equal(all[0].version, 0);
  assert.equal(all[0].source, 'create');
  assert.equal(all[1].version, 1);
  assert.equal(all[1].source, 'update');
  assert.equal(String(all[1].previousVersionId), String(all[0]._id));
});

test('createEquipmentDataVersion returns null when no changes', async () => {
  await EquipmentDataVersion.deleteMany({});

  const tenantId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  const snapshot = { Name: 'Same' };

  const result = await createEquipmentDataVersion({
    tenantId,
    equipmentId,
    changedBy: userId,
    source: 'update',
    oldSnapshot: snapshot,
    newSnapshot: snapshot,
    ensureBaseline: true
  });

  assert.equal(result, null);
  const count = await EquipmentDataVersion.countDocuments({ tenantId, equipmentId });
  assert.equal(count, 0);
});

