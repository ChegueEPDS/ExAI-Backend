require('dotenv').config();
const mongoose = require('mongoose');

const Equipment = require('../models/dataplate');
const Inspection = require('../models/inspection');

const siteId = new mongoose.Types.ObjectId('6a577d5f3ef4a3fbb6b4aceb');
const zoneId = new mongoose.Types.ObjectId('6a577e503ef4a3fbb6b4b0d0');

const commonRemarks = `Note 1: Final design, Installation, and Verification of the complete system of intrinsically safe circuits, including sizing and selection of safety barriers calculation,
control drawing, and descriptive system document, are the responsibility of the GTC package vendor, integrator, and end user. It shall be carried out according to
IEC 60079-25, IEC 60079-11, and IEC 60079-14. They are also responsible for compliance with Ex Certificates Specific Conditions of Use, and Manufacturers
Instructions of Individual Equipment, and Package Vendor(s)
Note 2: All the specific conditions of Ex equipment and schedule of limitations Ex components installed in the assembly are part of this document (see Annex) and
all relevant safety instructions shall be handed to the GTC package vendor, integrator, and end user, and be within manufacturer’s instructions, and must be
fulfilled.
Note 3: Integrator / End User responsible for tie in of individual / skid / package equipment bonding to skids / packages by others, and with onsite local earthing
systems`;

const groups = [
  {
    name: 'TUN/FMG/DEK/LCI/CSA/FMG group',
    certNumbers: [
      'IECEx TUN 10.0002X',
      'IECEx FMG 16.0014X',
      'IECEx DEK 11.0081X',
      'IECEx LCI 06.0003X',
      'IECEx CSA 17.0001X',
      'IECEx FMG 14.0018X'
    ],
    noteUpdates: [
      { references: ['5', '28', '48', '50', '51', '55', '56', '58', '59', 'SC1'], note: 'Note 1, Note 2' },
      { references: ['21'], note: 'Note 3' }
    ],
    statusUpdates: [
      { references: ['8', '14', '26', '27', '66', '67', '68'], status: 'NA' }
    ],
    remarks: commonRemarks
  },
  {
    name: 'CSA 16.0042X group',
    certNumbers: ['IECEx CSA 16.0042X'],
    noteUpdates: [
      { references: ['5', '28', '48', '50', '51', '55', '56', '58', '59', '71'], note: 'Note 1, Note 2' },
      { references: ['21'], note: 'Note 3' }
    ],
    statusUpdates: [
      { references: ['8', '14', '26', '27', '66', '67', '68'], status: 'NA' }
    ],
    remarks: commonRemarks
  },
  {
    name: 'PTB 12.0005X group',
    certNumbers: ['IECEx PTB 12.0005X'],
    noteUpdates: [
      { references: ['5', '28', 'SC1'], note: 'Note 1' },
      { references: ['21'], note: 'Note 2' }
    ],
    statusUpdates: [
      { references: ['8', '13', '14', '26', '27', '66', '67', '68'], status: 'NA' }
    ],
    remarks: commonRemarks
  },
  {
    name: 'IECEx CES 10.0010X group',
    certNumbers: ['IECEx CES 10.0010X'],
    noteUpdates: [
      { references: ['5', '28', 'SC1'], note: 'Note 1, Note 2' },
      { references: ['21'], note: 'Note 3' }
    ],
    statusUpdates: [
      { references: ['8', '14', '26', '29'], status: 'NA' }
    ],
    remarks: commonRemarks
  },
  {
    name: 'IECEx IBE 12.0031X group',
    certNumbers: ['IECEx IBE 12.0031X'],
    noteUpdates: [
      { references: ['5', 'SC1'], note: 'Note 1, Note 2' },
      { references: ['21'], note: 'Note 3' }
    ],
    statusUpdates: [
      { references: ['8', '14', '26', '27'], status: 'NA' }
    ],
    remarks: commonRemarks
  },
];

function summarizeUpdate(result) {
  return {
    matchedCount: result?.matchedCount || 0,
    modifiedCount: result?.modifiedCount || 0
  };
}

function uniqueObjectIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = String(value || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

async function equipmentIdsForCertNumbers(certNumbers) {
  const equipment = await Equipment.find({
    Site: siteId,
    $or: [
      { Zone: zoneId },
      { Unit: zoneId }
    ],
    schemaAssignments: {
      $elemMatch: {
        schemaKey: 'rb',
        'values.certificateNo': { $in: certNumbers }
      }
    }
  }).select('_id').lean();
  return equipment.map((item) => item._id);
}

async function countResultMatches(equipmentIds, references) {
  if (!equipmentIds.length || !references.length) return 0;
  return Inspection.countDocuments({
    siteId,
    zoneId,
    equipmentId: { $in: equipmentIds },
    'results.reference': { $in: references }
  });
}

async function updateResultNotes(equipmentIds, references, note, apply) {
  if (!equipmentIds.length || !references.length) return { matchedCount: 0, modifiedCount: 0 };
  if (!apply) return { matchedCount: await countResultMatches(equipmentIds, references), modifiedCount: 0 };

  return summarizeUpdate(await Inspection.updateMany(
    {
      siteId,
      zoneId,
      equipmentId: { $in: equipmentIds },
      'results.reference': { $in: references }
    },
    {
      $set: {
        'results.$[r].note': note,
        updatedAt: new Date()
      }
    },
    {
      arrayFilters: [
        { 'r.reference': { $in: references } }
      ]
    }
  ));
}

async function updateResultStatuses(equipmentIds, references, status, apply) {
  if (!equipmentIds.length || !references.length) return { matchedCount: 0, modifiedCount: 0 };
  if (!apply) return { matchedCount: await countResultMatches(equipmentIds, references), modifiedCount: 0 };

  return summarizeUpdate(await Inspection.updateMany(
    {
      siteId,
      zoneId,
      equipmentId: { $in: equipmentIds },
      'results.reference': { $in: references }
    },
    {
      $set: {
        'results.$[r].status': status,
        'results.$[r].severity': null,
        updatedAt: new Date()
      }
    },
    {
      arrayFilters: [
        { 'r.reference': { $in: references } }
      ]
    }
  ));
}

async function updateRemarks(equipmentIds, remarks, apply) {
  if (!equipmentIds.length || !remarks) return { matchedCount: 0, modifiedCount: 0 };
  const filter = {
    siteId,
    zoneId,
    equipmentId: { $in: equipmentIds }
  };
  if (!apply) return { matchedCount: await Inspection.countDocuments(filter), modifiedCount: 0 };

  return summarizeUpdate(await Inspection.updateMany(
    filter,
    {
      $set: {
        remarks,
        updatedAt: new Date()
      }
    }
  ));
}

async function recalculateInspectionSummaries(equipmentIds, apply) {
  if (!equipmentIds.length) return { matchedCount: 0, modifiedCount: 0 };
  const filter = {
    siteId,
    zoneId,
    equipmentId: { $in: equipmentIds }
  };
  if (!apply) return { matchedCount: await Inspection.countDocuments(filter), modifiedCount: 0 };

  return summarizeUpdate(await Inspection.updateMany(
    filter,
    [
      {
        $set: {
          'summary.failedCount': {
            $size: {
              $filter: {
                input: '$results',
                as: 'r',
                cond: { $eq: ['$$r.status', 'Failed'] }
              }
            }
          },
          'summary.naCount': {
            $size: {
              $filter: {
                input: '$results',
                as: 'r',
                cond: { $eq: ['$$r.status', 'NA'] }
              }
            }
          },
          'summary.passedCount': {
            $size: {
              $filter: {
                input: '$results',
                as: 'r',
                cond: { $eq: ['$$r.status', 'Passed'] }
              }
            }
          },
          updatedAt: '$$NOW'
        }
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ['$summary.failedCount', 0] }, 'Failed', 'Passed']
          },
          failureSeverity: {
            $let: {
              vars: {
                failedSeverities: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$results',
                        as: 'r',
                        cond: {
                          $and: [
                            { $eq: ['$$r.status', 'Failed'] },
                            { $in: ['$$r.severity', ['P1', 'P2', 'P3', 'P4']] }
                          ]
                        }
                      }
                    },
                    as: 'r',
                    in: '$$r.severity'
                  }
                }
              },
              in: {
                $switch: {
                  branches: [
                    { case: { $in: ['P1', '$$failedSeverities'] }, then: 'P1' },
                    { case: { $in: ['P2', '$$failedSeverities'] }, then: 'P2' },
                    { case: { $in: ['P3', '$$failedSeverities'] }, then: 'P3' },
                    { case: { $in: ['P4', '$$failedSeverities'] }, then: 'P4' }
                  ],
                  default: null
                }
              }
            }
          }
        }
      }
    ]
  ));
}

async function main() {
  const apply = ['1', 'true', 'yes'].includes(String(process.env.APPLY || '').toLowerCase());
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    maxPoolSize: 5,
    autoIndex: false
  });

  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    siteId: String(siteId),
    zoneId: String(zoneId)
  }, null, 2));

  let touchedEquipmentIds = [];

  for (const group of groups) {
    const equipmentIds = await equipmentIdsForCertNumbers(group.certNumbers);
    touchedEquipmentIds = touchedEquipmentIds.concat(equipmentIds);
    console.log(`\n${group.name}`);
    console.log(`certNumbers: ${group.certNumbers.join(', ')}`);
    console.log(`equipmentIds: ${equipmentIds.length}`);

    for (const update of group.noteUpdates) {
      const result = await updateResultNotes(equipmentIds, update.references, update.note, apply);
      console.log(`note "${update.note}" refs ${update.references.join(', ')} matched=${result.matchedCount} modified=${result.modifiedCount}`);
    }

    for (const update of group.statusUpdates) {
      const result = await updateResultStatuses(equipmentIds, update.references, update.status, apply);
      console.log(`status "${update.status}" refs ${update.references.join(', ')} matched=${result.matchedCount} modified=${result.modifiedCount}`);
    }

    const remarksResult = await updateRemarks(equipmentIds, group.remarks, apply);
    console.log(`remarks matched=${remarksResult.matchedCount} modified=${remarksResult.modifiedCount}`);
  }

  const summaryResult = await recalculateInspectionSummaries(uniqueObjectIds(touchedEquipmentIds), apply);
  console.log(`\ninspection summary recalculation matched=${summaryResult.matchedCount} modified=${summaryResult.modifiedCount}`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch {}
  process.exitCode = 1;
});
