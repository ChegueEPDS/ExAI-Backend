const mongoose = require('mongoose');
const Unit = require('./unit');

module.exports = mongoose.models.Zone || mongoose.model('Zone', Unit.schema, Unit.collection.name);
