const mongoose = require('mongoose');

const QuestionSchema = new mongoose.Schema({
    questionID: { type: String, required: true },
    questionEng: { type: String, required: true },
    questionHun: { type: String },
    grade: [{ type: String, enum: ["detailed", "visual", "close"] }],  // Array of grades with enum validation
    protection: [{ 
        type: String, 
        enum: [
            "d", "da", "db", "dc", "e", "eb", "ec", 
            "m", "ma", "mb", "mc", "mD", "maD", "mbD", "mcD", 
            "o", "ob", "oc", "op", "op_is", "op_pr", "op_sh", 
            "n", "nA", "nC", "nR", 
            "q", "qb", 
            "t", "ta", "tb", "tc", "tD", "taD", "tbD", "tcD", 
            "s", "sa", "sb", "sc"
        ], 
        default: ["d"] 
    }],  // Array of protections with updated enum validation
    type: { 
        type: String, 
        required: true,
        enum: [
            "GENERAL (ALL EQUIPMENT)", 
            "EQUIPMENT SPECIFIC (LIGHTING)",  
            "EQUIPMENT SPECIFIC (MOTORS)", 
            "INSTALLATION – GENERAL", 
            "INSTALLATION – HEATING SYSTEMS", 
            "INSTALLATION – MOTORS", 
            "ENVIRONMENT"
        ]  // Valid types of equipment
    },
}, { timestamps: true });

module.exports = mongoose.model('Question', QuestionSchema);