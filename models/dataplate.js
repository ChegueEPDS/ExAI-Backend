const mongoose = require('mongoose');

const ExMarkingSchema = new mongoose.Schema({
  "Marking": { type: String },
  "Equipment Group": { type: String },
  "Equipment Category": { type: String },
  "Environment": { type: String },
  "Type of Protection": { type: String },
  "Gas / Dust Group": { type: String },
  "Temperature Class": { type: String },
  "Equipment Protection Level": { type: String }
});

const EquipmentSchema = new mongoose.Schema({
  "EqID": { type: String },
  "TagNo": { type: String },
  // Sorszám / index az adott zónán (vagy projekten) belül
  orderIndex: { type: Number, default: null, index: true },
  "Manufacturer": { type: String },
  "Model/Type": { type: String },
  "Serial Number": { type: String },
  "Equipment Type": { type: String, default: "-" },
  "Ex Marking": { type: [ExMarkingSchema], default: [] },
  "IP rating": String,
  "Max Ambient Temp": { type: String },
  "Certificate No": String,
  "X condition": {
    "X": Boolean,
    "Specific": String 
  },
  "Other Info": { type: String },
  "Compliance": { 
    type: String, 
    enum: ["NA", "Passed", "Failed"], 
    default: "NA" 
  },
  "Qualitycheck": { type: Boolean, default: false },
  "CreatedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  "ModifiedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // 🆕 Módosító felhasználó
  "tenantId": { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  "Zone": { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' },
  "Site": { type: mongoose.Schema.Types.ObjectId, ref: 'Site' },
  "Pictures": [
    {
      name: { type: String },            // original filename (cleaned)
      alias: { type: String },           // optional display name
      blobPath: { type: String },        // container-relative path (e.g. TENANT_X/projects/.../EqID/file.jpg)
      blobUrl: { type: String },         // direct HTTPS (no SAS)
      contentType: { type: String },     // MIME type, e.g. image/jpeg
      size: { type: Number },            // bytes
      uploadedAt: { type: Date, default: Date.now },
      tag: { type: String, enum: ['dataplate', 'general', 'fault'], default: 'general' }
    }
  ],
  "documents": [
    {
      name: { type: String },            // original filename (cleaned)
      alias: { type: String },           // optional display name shown in UI
      type: { type: String, enum: ['document', 'image'], default: 'document' },
      blobPath: { type: String },        // container-relative path in Blob (e.g. Equipment/EqID/file.pdf)
      blobUrl: { type: String },         // direct HTTPS URL (no SAS)
      contentType: { type: String },     // MIME type, e.g. application/pdf, image/jpeg
      size: { type: Number },            // bytes
      uploadedAt: { type: Date, default: Date.now },
      tag: { type: String, enum: ['dataplate', 'general', 'fault'], default: undefined }
    }
  ],

  // ---- Inspection summary (denormalized from Inspection collection) ----
  lastInspectionDate: { type: Date, default: null },
  lastInspectionValidUntil: { type: Date, default: null },
  lastInspectionStatus: {
    type: String,
    enum: ['Passed', 'Failed', 'NA', null],
    default: null
  },
  lastInspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inspection', default: null }
}, { timestamps: true }); // ⏳ Timestamps (createdAt, updatedAt)

// 🔹 Pre-save middleware: kezeli a tenantId és Company mezőket mentéskor
EquipmentSchema.pre('save', async function (next) {
    if (!this.CreatedBy) {
        return next(new Error('CreatedBy mező szükséges.'));
    }

    try {
        const user = await mongoose.model('User').findById(this.CreatedBy).select('company tenantId');
        if (!user) {
            return next(new Error('Invalid CreatedBy user.'));
        }

        // Fill tenantId if missing
        if (!this.tenantId && user.tenantId) {
            this.tenantId = user.tenantId;
        }

        next();
    } catch (error) {
        next(error);
    }
});

// 🔹 Pre-update middleware: módosításkor beállítja a ModifiedBy mezőt
EquipmentSchema.pre('findOneAndUpdate', async function (next) {
    const update = this.getUpdate();
    if (!update) return next();

    if (update.$set && update.$set.ModifiedBy) {
        return next(); // Ha már megadott egy ModifiedBy értéket, nem kell változtatni
    }

    if (!update.$set) {
        update.$set = {};
    }

    if (!this.options.context || !this.options.context.userId) {
        return next(new Error('ModifiedBy mező szükséges a módosításokhoz.'));
    }

    // Az aktuális felhasználót állítjuk be módosítóként
    update.$set.ModifiedBy = this.options.context.userId;
    update.$set.updatedAt = new Date(); // Frissítjük az időbélyeget is

    next();
});

module.exports = mongoose.model('Equipment', EquipmentSchema);
