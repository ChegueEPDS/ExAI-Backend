const mongoose = require('mongoose');

const DatasetTableSchemaSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dataset', required: true, index: true },
    datasetVersion: { type: Number, required: true, index: true },
    datasetFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetFile', required: true, index: true },

    filename: { type: String, required: true, trim: true },

    status: { type: String, enum: ['pending', 'ready', 'error'], default: 'pending', index: true },
    error: { type: String, default: '' },

    // LLM-inferred (validated) schema. Expected to contain sheets[] with tables[] definitions.
    schema: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DatasetTableSchemaSchema.index(
  { tenantId: 1, projectId: 1, datasetVersion: 1, datasetFileId: 1 },
  { unique: true }
);
DatasetTableSchemaSchema.index({ tenantId: 1, projectId: 1, datasetVersion: 1, updatedAt: -1 });

module.exports = mongoose.model('DatasetTableSchema', DatasetTableSchemaSchema);

