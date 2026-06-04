// models/inspection.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const InspectionResultSchema = new Schema(
  {
    // Kapcsolat a kérdéshez
    questionId: { type: Schema.Types.ObjectId, ref: 'Question', required: false },
    schemaQuestionKey: { type: String, required: false },
    questionOrigin: { type: String, enum: ['legacy', 'system', 'tenant', null], default: null },

    // Azonosítók (snapshot, hogy később is érthető maradjon)
    table: { type: String, required: false },   // pl. "T1"
    group: { type: String, required: false },   // pl. "G2"
    number: { type: Number, required: false },  // pl. 3
    equipmentType: { type: String, required: false },
    protectionTypes: [{ type: String }],

    // Válasz státusz
    status: {
      type: String,
      enum: ['Passed', 'Failed', 'NA'],
      required: true,
    },

    // Rövid megjegyzés, főleg Failed esetén (de lehet NA/Passed-re is)
    note: { type: String },

    // Severity only relevant when status === 'Failed'
    severity: { type: String, enum: ['P1', 'P2', 'P3', 'P4', null], default: null },

    // Kérdés szöveg snapshot (hogy ha később változik a question DB, ez akkor is megmaradjon)
    questionText: {
      eng: { type: String, required: false },
      hun: { type: String, required: false },
    },
  },
  { _id: false } // nem kell külön _id minden sorhoz
);

const InspectionAttachmentSchema = new Schema(
  {
    blobPath: { type: String, required: true }, // Equipment/<EqID>/... path
    blobUrl: { type: String, required: true },
    type: {
      type: String,
      enum: ['image', 'document'],
      default: 'image',
    },
    contentType: { type: String },
    size: { type: Number },

    // Opcionális kapcsolódás konkrét kérdéshez
    questionId: { type: Schema.Types.ObjectId, ref: 'Question', required: false },
    questionKey: { type: String, required: false }, // pl. "T1-G2-3"

    // Szöveges megjegyzés: melyik inspection, melyik hiba, rövid leírás
    note: { type: String, required: false },

    createdAt: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  { _id: false }
);

const InspectionSchema = new Schema(
  {
    // Kapcsolatok
    equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', required: true },
    eqId: { type: String, required: true }, // EqID string, gyors kereséshez

    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: false },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: false },
    zoneId: { type: Schema.Types.ObjectId, ref: 'Unit', required: false },

    // 1. Metaadatok a vizsgálatról
    inspectionDate: { type: Date, required: true },  // mikor végezték (user adja meg)
    validUntil: { type: Date, required: true },      // meddig érvényes (user adja meg)
    inspectorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Type of inspection: Detailed / Initial Detailed / Initial Detailed (Index) / Close / Visual
    inspectionType: {
      type: String,
      enum: ['Detailed', 'Initial Detailed', 'Initial Detailed (Index)', 'Close', 'Visual', 'Criteria'],
      required: true,
    },
    schemaId: { type: Schema.Types.ObjectId, ref: 'SchemaDefinition', default: null, index: true },
    schemaKeySnapshot: { type: String, default: '' },
    schemaNameSnapshot: { type: String, default: '' },
    schemaTypeSnapshot: { type: String, enum: ['compliance', 'maintenance', null], default: null },

    // 2. Eredmények (MINDEN kérdés, nem csak Failed/NA)
    results: {
      type: [InspectionResultSchema],
      default: [],
    },

    // 3. Képek / dokumentumok a vizsgálathoz
    attachments: {
      type: [InspectionAttachmentSchema],
      default: [],
    },

    // Összefoglaló (reporthoz, gyors szűréshez)
    summary: {
      failedCount: { type: Number, default: 0 },
      naCount: { type: Number, default: 0 },
      passedCount: { type: Number, default: 0 },
    },

    // Inspection össz-státusz (ha bármelyik Failed -> Failed, különben Passed)
    status: {
      type: String,
      enum: ['Passed', 'Failed'],
      required: true,
    },

    // Aggregated failure severity for the inspection (max severity across failed items)
    // null when status === 'Passed'
    failureSeverity: {
      type: String,
      enum: ['P1', 'P2', 'P3', 'P4', null],
      default: null,
      index: true
    },

    // Review workflow (mobile sync creates pending inspections)
    reviewStatus: {
      type: String,
      enum: ['pending', 'final'],
      default: 'final',
      index: true
    },
    source: {
      type: String,
      enum: ['manual', 'mobileSync', 'import', 'unknown'],
      default: 'manual',
      index: true
    },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false }
  },
  {
    timestamps: true, // createdAt, updatedAt automatikusan
  }
);

InspectionSchema.index({
  tenantId: 1,
  equipmentId: 1,
  finalizedAt: 1,
  createdAt: 1,
  inspectionDate: 1,
  _id: 1
});
InspectionSchema.index({
  tenantId: 1,
  equipmentId: 1,
  schemaId: 1,
  finalizedAt: 1,
  createdAt: 1,
  inspectionDate: 1,
  _id: 1
});
InspectionSchema.index({
  tenantId: 1,
  equipmentId: 1,
  reviewStatus: 1,
  schemaId: 1
});
InspectionSchema.index({
  tenantId: 1,
  equipmentId: 1,
  inspectionDate: -1,
  createdAt: -1
});

InspectionSchema.post('save', function scheduleDashboardIncidentRefresh(doc) {
  try {
    if (!doc?.tenantId || !doc?.equipmentId) return;
    require('../services/dashboardIncidentService').scheduleRecomputeEquipmentIncidents({
      tenantId: doc.tenantId,
      equipmentId: doc.equipmentId
    });
  } catch {
    // Best-effort cache refresh; never block inspection writes.
  }
});

module.exports = mongoose.model('Inspection', InspectionSchema);
