const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachEquipmentMarkings,
  equipmentMarkings,
  primaryEquipmentMarking,
  protectionText,
  valuesFromEquipmentMarkings,
  zoneView
} = require('../services/rbSchemaValueService');

test('zoneView reads RB values from schemaAssignments', () => {
  const zone = {
    Environment: 'NonEx',
    schemaAssignments: [{
      schemaKey: 'rb',
      values: {
        scheme: 'ATEX',
        environment: 'Gas',
        zone: [1],
        subGroup: ['IIB'],
        tempClass: 'T4',
        ipRating: 'IP66',
        epl: ['Gb']
      }
    }]
  };

  const rb = zoneView(zone);
  assert.equal(rb.Environment, 'Gas');
  assert.deepEqual(rb.Zone, [1]);
  assert.deepEqual(rb.SubGroup, ['IIB']);
  assert.equal(rb.TempClass, 'T4');
  assert.equal(Object.prototype.hasOwnProperty.call(rb, 'IpRating'), false);
  assert.equal(rb.IPRating, 'IP66');
  assert.deepEqual(rb.EPL, ['Gb']);
});

test('equipmentMarkings ignores legacy Ex Marking when RB schema exists', () => {
  const equipment = {
    'Ex Marking': [{ 'Type of Protection': 'legacy' }],
    schemaAssignments: [{
      schemaKey: 'rb',
      values: {
        exMarking: [{ 'Type of Protection': 'db', 'Gas / Dust Group': 'IIC' }]
      }
    }]
  };

  assert.equal(protectionText(equipment), 'db');
  assert.deepEqual(primaryEquipmentMarking(equipment), { 'Type of Protection': 'db', 'Gas / Dust Group': 'IIC' });
});

test('protectionText prefers explicit Type of Protection over Marking', () => {
  const equipment = {
    schemaAssignments: [{
      schemaKey: 'rb',
      values: {
        exMarking: [{ 'Type of Protection': 'db', Marking: 'Ex eb IIC T4 Gb' }]
      }
    }]
  };

  assert.equal(protectionText(equipment), 'db');
});

test('protectionText falls back to Marking when Type of Protection is missing', () => {
  const equipment = {
    schemaAssignments: [{
      schemaKey: 'rb',
      values: {
        exMarking: [{ Marking: 'Ex db IIIC T120 °C Db' }]
      }
    }]
  };

  assert.equal(protectionText(equipment), 'Ex db IIIC T120 °C Db');
});

test('protectionText uses structured protectionTypes before Marking', () => {
  const equipment = {
    schemaAssignments: [{
      schemaKey: 'rb',
      values: {
        protectionTypes: ['db'],
        exMarking: [{ Marking: 'Ex eb IIC T4 Gb' }]
      }
    }]
  };

  assert.equal(protectionText(equipment), 'db');
});

test('valuesFromEquipmentMarkings maps legacy marking shape into RB values', () => {
  const values = valuesFromEquipmentMarkings([{
    Environment: 'G',
    'Type of Protection': 'db; eb',
    'Gas / Dust Group': 'IIC',
    'Temperature Class': 'T4',
    'Equipment Protection Level': 'Gb'
  }]);

  assert.equal(values.environment, 'Gas');
  assert.deepEqual(values.protectionTypes, ['db; eb']);
  assert.deepEqual(values.subGroup, ['IIC']);
  assert.equal(values.tempClass, 'T4');
  assert.deepEqual(values.epl, ['Gb']);
  assert.equal(values.exMarking.length, 1);
});

test('attachEquipmentMarkings upserts RB assignment without touching legacy fields', () => {
  const equipment = { schemaAssignments: [] };
  attachEquipmentMarkings(
    equipment,
    { _id: '507f1f77bcf86cd799439011' },
    [{ Environment: 'D', 'Type of Protection': 'tb' }],
    '507f1f77bcf86cd799439012'
  );

  assert.equal(equipment.schemaAssignments.length, 1);
  assert.equal(equipment.schemaAssignments[0].schemaKey, 'rb');
  assert.equal(equipment.schemaAssignments[0].values.environment, 'Dust');
  assert.equal(equipment['Ex Marking'], undefined);
});
