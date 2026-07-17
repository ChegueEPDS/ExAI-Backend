const mongoose = require('mongoose');

const QuestionsSchema = new mongoose.Schema({
    questionText: {
        eng: { type: String, required: true },
        hun: { type: String }
        },

  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },

  standard: {
    type: String
  },

  table: {
    type: String
  },

  group: {
    type: String
  },

  number: {
    type: Number
  },

  protectionTypes: [{
    type: String, // pl. "d", "e", "ia", "ib", stb.
    enum: [
        "b", "c", "d", "da", "db", "dc", "e", "eb", "ec", "h", "i", "ia", "iaD", "ib", "ibD", "ic", "icD", "iD", "k", "m", "ma", "maD", "mb", "mbD", "mc", "mcD", "mD", "n", "nA", "nC", "nL", "nP", "nR", "o", "ob", "oc", "op", "op is", "op pr", "op sh", "p", "pb", "pc", "pD", "px", "pxb", "py", "pyb", "pz", "pzc", "q", "qb", "s", "sa", "sb", "sc", "t", "ta", "taD", "tb", "tbD", "tc", "tcD", "tD", "pv", "vc", "NA"
      ],
    required: true
  }],

  inspectionTypes: [{
    type: String, // pl. "D", "C", "V"
    enum: ["Detailed", "Initial Detailed", "Initial Detailed (Index)", "Close", "Visual"],
    required: true
  }],

  equipmentCategories: {
    type: String, 
  },

  equipmentType: {
    type: String,
    enum: ["General", "Motors", "Electrical Machines", "Lighting", "Installation", "Installation Electrical Machines", "Installation Heating System", "Installation Motors", "Environment", "Equipment", "Additional Checks"],
  },
});

QuestionsSchema.index({ tenantId: 1, equipmentType: 1 });

module.exports = mongoose.model('Question', QuestionsSchema);
