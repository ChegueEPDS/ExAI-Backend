const mongoose = require('mongoose');

const injectionRuleSchema = new mongoose.Schema({
  pattern: { type: String, required: true },
  injectedKnowledge: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // ha szükséges
});

module.exports = mongoose.model('InjectionRule', injectionRuleSchema);
