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
  "Manufacturer": { type: String, required: true },
  "Model/Type": { type: String, required: true },
  "Serial Number": { type: String, required: true },
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
  "Project": { type: String, ref: 'Project', default: null }
});

module.exports = mongoose.model('Equipment', EquipmentSchema);