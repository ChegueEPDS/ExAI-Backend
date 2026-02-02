const mongoose = require('mongoose');

const DatasetDerivedMetricSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dataset', required: true, index: true },
    datasetVersion: { type: Number, required: true, index: true },
    datasetFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetFile', required: true, index: true },

    filename: { type: String, required: true, trim: true },
    sheet: { type: String, default: '' },

    // Stable id so the model can cite a derived value.
    derivedId: { type: String, required: true, trim: true },

    metricKey: { type: String, required: true, trim: true }, // e.g. "timeseries.max"
    label: { type: String, default: '' }, // human-friendly
    unit: { type: String, default: '' },

    valueNumber: { type: Number, default: null, index: true },
    valueText: { type: String, default: '' }, // exact formatting used in context

    op: { type: String, default: '' }, // e.g. "max", "min", "at_time", ...

    // Cell sources used to compute the metric (must be traceable).
    sources: { type: [mongoose.Schema.Types.Mixed], default: [] },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DatasetDerivedMetricSchema.index(
  { tenantId: 1, projectId: 1, datasetVersion: 1, derivedId: 1 },
  { unique: true }
);
DatasetDerivedMetricSchema.index({ tenantId: 1, projectId: 1, datasetVersion: 1, filename: 1, sheet: 1 });

module.exports = mongoose.model('DatasetDerivedMetric', DatasetDerivedMetricSchema);

