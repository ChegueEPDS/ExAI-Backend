const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
    "Project": { type: String, required: true },
    "Environment": { type: String, required: true, enum: ['Gas', 'Dust', 'NA'] },
    "Zone": { 
        type: Number, 
        enum: [0, 1, 2, 20, 21, 22], 
        default: null // Alapértelmezett érték null, ha nincs megadva
    },
    "CreatedBy": { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true }); // Automatikusan hozzáadja a createdAt és updatedAt mezőket

module.exports = mongoose.model('Project', ProjectSchema);