// models/DxfJob.js
const mongoose = require('mongoose');

const DxfJobSchema = new mongoose.Schema({
  job_id:       { type: String, required: true, unique: true },
  filename:     { type: String, required: true },
  size_bytes:   { type: Number },
  content_type: { type: String },

  // ⬇️ ÚJ: tulaj / létrehozó
  owner_user_id: { type: String },   // req.userId vagy JWT sub
  owner_company: { type: String },   // ha a tokenben van

  created_at:   { type: Date, default: Date.now },
  finished_at:  { type: Date },

  status:       { type: String, enum: ['queued','running','succeeded','failed'], required: true },
  error_message:{ type: String },

  raw_blob_url:    { type: String },
  result_blob_url: { type: String },
  svg_blob_url:    { type: String },

  version:      { type: Number, default: 1 },

  pipe_count:    { type: Number },
  group_count:   { type: Number },
  fitting_count: { type: Number }
}, { collection: 'dxf_jobs' });

DxfJobSchema.index({ created_at: -1 });
DxfJobSchema.index({ status: 1 });
// ⬇️ ÚJ: sajátjaim gyors listázásához
DxfJobSchema.index({ owner_user_id: 1, created_at: -1 });

module.exports = mongoose.model('DxfJob', DxfJobSchema);