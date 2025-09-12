const mongoose = require('mongoose');

const injectionRuleSchema = new mongoose.Schema({
  pattern: { type: String, required: true },
  injectedKnowledge: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // ha szükséges
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
});

injectionRuleSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('InjectionRule', injectionRuleSchema);
