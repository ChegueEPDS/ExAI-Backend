const mongoose = require('mongoose');

const DatasetTableCellSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dataset', required: true, index: true },
    datasetVersion: { type: Number, required: true, index: true },
    datasetFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetFile', required: true, index: true },

    filename: { type: String, required: true, trim: true },
    sheet: { type: String, default: '' },
    rowIndex: { type: Number, required: true },
    colIndex: { type: Number, required: true },
    // Excel-like coordinate (best-effort). Recommended for user-facing traceability.
    cell: { type: String, default: '' },

    colHeader: { type: String, default: '' },
    rowHeader: { type: String, default: '' },

    valueRaw: { type: String, default: '' },
    valueNumber: { type: Number, default: null, index: true },
  },
  { timestamps: true }
);

DatasetTableCellSchema.index(
  { tenantId: 1, projectId: 1, datasetVersion: 1, datasetFileId: 1, sheet: 1, rowIndex: 1, colIndex: 1 },
  { unique: true }
);
DatasetTableCellSchema.index({ tenantId: 1, projectId: 1, datasetVersion: 1, valueNumber: 1 });

module.exports = mongoose.model('DatasetTableCell', DatasetTableCellSchema);
