const mongoose = require('mongoose');

const DatasetDocChunkSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dataset', required: true, index: true },
    datasetVersion: { type: Number, required: true, index: true },
    datasetFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetFile', required: true, index: true },

    filename: { type: String, required: true, trim: true },
    chunkIndex: { type: Number, required: true },

    text: { type: String, required: true },
    tokens: { type: Number, default: 0 },
    embedding: { type: [Number], default: [] },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DatasetDocChunkSchema.index(
  { tenantId: 1, projectId: 1, datasetVersion: 1, datasetFileId: 1, chunkIndex: 1 },
  { unique: true }
);
DatasetDocChunkSchema.index({ tenantId: 1, projectId: 1, datasetVersion: 1, filename: 1, chunkIndex: 1 });

module.exports = mongoose.model('DatasetDocChunk', DatasetDocChunkSchema);

