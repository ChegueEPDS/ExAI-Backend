const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
    "Project": { type: String, required: true },
    "Environment": { type: String, required: true, enum: ['Gas', 'Dust', 'Hybrid', 'NonEx'] },
    "Zone": { 
        type: Number, 
        enum: [0, 1, 2, 20, 21, 22], 
        default: null // Alapértelmezett érték null, ha nincs megadva
    },
    "SubGroup": { type: String, required: true, enum: ['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC'] },
    "TempClass": { type: String, required: true, enum: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] },
    "MaxTemp": { type: Number, required: true },
    "CreatedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true }); // Automatikusan hozzáadja a createdAt és updatedAt mezőket

module.exports = mongoose.model('Project', ProjectSchema);