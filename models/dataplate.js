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
  "CreatedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  "ModifiedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // 🆕 Módosító felhasználó
  "Company": { type: String, required: true },
  "Zone": { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' },
  "Site": { type: mongoose.Schema.Types.ObjectId, ref: 'Site' },
  "Pictures": [
    {
      name: { type: String },
      oneDriveId: { type: String },
      oneDriveUrl: { type: String },
      uploadedAt: { type: Date, default: Date.now }
    }
  ],
  "OneDriveFolderId": { type: String },
  "OneDriveFolderUrl": { type: String }
}, { timestamps: true }); // ⏳ Timestamps (createdAt, updatedAt)

// 🔹 Pre-save middleware: beállítja a CreatedBy és Company mezőt az első mentéskor
EquipmentSchema.pre('save', async function (next) {
    if (!this.CreatedBy) {
        return next(new Error('CreatedBy mező szükséges.'));
    }

    try {
        const user = await mongoose.model('User').findById(this.CreatedBy);
        if (!user) {
            return next(new Error('Invalid CreatedBy user.'));
        }

        // Beállítjuk a Company mezőt a felhasználó cégéhez
        this.Company = user.company;

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