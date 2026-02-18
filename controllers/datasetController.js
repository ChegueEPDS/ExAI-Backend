const crypto = require('crypto');
const multer = require('multer');
const Dataset = require('../models/dataset');
const DatasetFile = require('../models/datasetFile');
const logger = require('../config/logger');
const { ingestTabularFileBuffer, ingestDocumentFileBuffer, deleteDatasetFileArtifacts } = require('../services/datasetIngestionService');
const azureBlob = require('../services/azureBlobService');
const systemSettings = require('../services/systemSettingsStore');
const { notifyAndStore } = require('../lib/notifications/notifier');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
exports.uploadMulter = upload;

function requireProjectId(req) {
  const projectId = String(req.params.projectId || req.body?.projectId || '').trim();
  if (!projectId) throw new Error('projectId is required');
  return projectId;
}

async function resolveOrCreateDataset({ tenantId, projectId, userId, version }) {
  if (version !== null && version !== undefined) {
    const v = Number(version);
    if (!Number.isInteger(v) || v <= 0) throw new Error('dataset version must be a positive integer');
    const ds = await Dataset.findOne({ tenantId, projectId, version: v });
    if (!ds) throw new Error('dataset version not found');
    return ds;
  }

  const last = await Dataset.findOne({ tenantId, projectId }).sort({ version: -1 }).select('version').lean();
  const nextVersion = (last?.version || 0) + 1;
  return Dataset.create({ tenantId, projectId, version: nextVersion, createdBy: userId, status: 'draft' });
}

exports.createDataset = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.userId;
    const projectId = requireProjectId(req);
    const ds = await resolveOrCreateDataset({ tenantId, projectId, userId, version: null });
    return res.status(201).json({ ok: true, dataset: { id: ds._id, projectId: ds.projectId, version: ds.version, status: ds.status } });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.listDatasets = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const projectId = requireProjectId(req);
    const items = await Dataset.find({ tenantId, projectId }).sort({ version: -1 }).lean();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.listDatasetFiles = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const projectId = requireProjectId(req);
    const datasetVersion = Number(req.params.version);
    if (!Number.isInteger(datasetVersion) || datasetVersion <= 0) {
      return res.status(400).json({ ok: false, error: 'dataset version must be a positive integer' });
    }

    const ds = await Dataset.findOne({ tenantId, projectId, version: datasetVersion }).select('_id version status').lean();
    if (!ds) return res.status(404).json({ ok: false, error: 'dataset not found' });

    const items = await DatasetFile.find({ tenantId, projectId, datasetVersion })
      .sort({ updatedAt: -1 })
      .select('filename contentType size sha256 approvalStatus indexingStatus indexingError storage createdAt updatedAt')
      .lean();

    return res.json({
      ok: true,
      dataset: { id: String(ds._id), version: ds.version, status: ds.status },
      items,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.uploadDatasetFiles = [
  upload.array('files', 10),
  async (req, res) => {
    try {
      const tenantId = req.scope?.tenantId;
      const userId = req.userId;
      const projectId = requireProjectId(req);
      const datasetVersion = Number(req.params.version);
      const ds = await resolveOrCreateDataset({ tenantId, projectId, userId, version: datasetVersion });
      if (ds.status === 'approved') return res.status(409).json({ ok: false, error: 'dataset is approved; create a new version' });

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'no files uploaded' });

      const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');
      try {
        logger.info('dataset.upload.start', {
          requestId: req.requestId,
          tenantId: String(tenantId || ''),
          userId: String(userId || ''),
          projectId,
          datasetVersion: ds.version,
          files: files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
        });
      } catch { }

      const results = [];
      for (const f of files) {
        const filename = String(f.originalname || 'upload.bin');
        const lower = filename.toLowerCase();
        const isSpreadsheet = lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.endsWith('.csv');
        const contentType = String(f.mimetype || 'application/octet-stream');
        const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
        const blobPath = `datasets/${tenantId}/${projectId}/v${ds.version}/${Date.now()}-${sha256}-${filename}`.replace(/\s+/g, '_');
        await azureBlob.uploadBuffer(blobPath, f.buffer, contentType, { overwrite: true });

        if (debugEnabled) {
          try { logger.info('dataset.upload.file', { requestId: req.requestId, projectId, datasetVersion: ds.version, filename, kind: isSpreadsheet ? 'tabular' : 'document', blobPath }); } catch { }
        }

        const ing = isSpreadsheet
          ? await ingestTabularFileBuffer({
            tenantId,
            projectId,
            datasetId: ds._id,
            datasetVersion: ds.version,
            userId,
            fileBuffer: f.buffer,
            filename,
            contentType,
            blobPath,
            trace: { requestId: req.requestId },
          })
          : await ingestDocumentFileBuffer({
            tenantId,
            projectId,
            datasetId: ds._id,
            datasetVersion: ds.version,
            userId,
            fileBuffer: f.buffer,
            filename,
            contentType,
            blobPath,
            trace: { requestId: req.requestId },
          });
        results.push({ filename, kind: isSpreadsheet ? 'tabular' : 'document', ...ing });
      }

      try { logger.info('dataset.upload.done', { requestId: req.requestId, projectId, datasetVersion: ds.version, files: results.length }); } catch { }
      return res.status(201).json({ ok: true, dataset: { id: ds._id, version: ds.version, status: ds.status }, files: results });
    } catch (e) {
      try { logger.error('dataset.upload.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
      return res.status(400).json({ ok: false, error: e?.message || 'failed' });
    }
  }
];

exports.uploadDatasetFilesStream = [
  upload.array('files', 10),
  async (req, res) => {
    const { initSse } = require('../services/sseService');
    const send = initSse(req, res, {
      // Some frontends ignore SSE comment lines as "activity".
      // Emit a real event heartbeat so the UI doesn't time out during ingest.
      heartbeatMs: (() => {
        const raw = Number(systemSettings.getNumber('DATASET_UPLOAD_SSE_HEARTBEAT_MS') || 10_000);
        return Math.max(1000, Math.min(raw, 60000));
      })(),
      heartbeatEvent: 'ping',
      setClosedFlag: 'sseClosed',
      onClose: ({ req: req0 }) => {
        try { logger.warn('dataset.sse.closed', { requestId: req0?.requestId, path: req0?.originalUrl }); } catch { }
      }
    });
    try {
      const tenantId = req.scope?.tenantId;
      const userId = req.userId;
      const projectId = requireProjectId(req);
      const datasetVersion = Number(req.params.version);

      send('progress', { stage: 'dataset.resolve', projectId, datasetVersion });
      const ds = await resolveOrCreateDataset({ tenantId, projectId, userId, version: datasetVersion });
      if (ds.status === 'approved') {
        send('error', { error: 'dataset is approved; create a new version' });
        return res.end();
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        send('error', { error: 'no files uploaded' });
        return res.end();
      }

      const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');

      try {
        logger.info('dataset.upload.start', {
          requestId: req.requestId,
          tenantId: String(tenantId || ''),
          userId: String(userId || ''),
          projectId,
          datasetVersion: ds.version,
          files: files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
        });
      } catch { }

      send('progress', {
        stage: 'upload.start',
        datasetVersion: ds.version,
        files: files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
      });

      const results = [];
      let idx = 0;
      for (const f of files) {
        idx += 1;
        if (req.aborted || res.writableEnded) break;

        const filename = String(f.originalname || 'upload.bin');
        const lower = filename.toLowerCase();
        const isSpreadsheet = lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.endsWith('.csv');
        const contentType = String(f.mimetype || 'application/octet-stream');
        const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
        const blobPath = `datasets/${tenantId}/${projectId}/v${ds.version}/${Date.now()}-${sha256}-${filename}`.replace(/\s+/g, '_');

        send('progress', { stage: 'upload.file', idx, total: files.length, filename, kind: isSpreadsheet ? 'tabular' : 'document' });
        await azureBlob.uploadBuffer(blobPath, f.buffer, contentType, { overwrite: true });

        if (debugEnabled) {
          try { logger.info('dataset.upload.file', { requestId: req.requestId, projectId, datasetVersion: ds.version, filename, kind: isSpreadsheet ? 'tabular' : 'document', blobPath }); } catch { }
        }

        send('progress', { stage: 'ingest.start', filename, kind: isSpreadsheet ? 'tabular' : 'document' });
        const ing = isSpreadsheet
          ? await ingestTabularFileBuffer({
            tenantId,
            projectId,
            datasetId: ds._id,
            datasetVersion: ds.version,
            userId,
            fileBuffer: f.buffer,
            filename,
            contentType,
            blobPath,
            trace: { requestId: req.requestId },
          })
          : await ingestDocumentFileBuffer({
            tenantId,
            projectId,
            datasetId: ds._id,
            datasetVersion: ds.version,
            userId,
            fileBuffer: f.buffer,
            filename,
            contentType,
            blobPath,
            trace: { requestId: req.requestId },
          });
        results.push({ filename, kind: isSpreadsheet ? 'tabular' : 'document', ...ing });
        send('progress', { stage: 'ingest.done', filename, kind: isSpreadsheet ? 'tabular' : 'document' });
      }

      try { logger.info('dataset.upload.done', { requestId: req.requestId, projectId, datasetVersion: ds.version, files: results.length }); } catch { }
      send('final', { ok: true, dataset: { id: String(ds._id), version: ds.version, status: ds.status }, files: results });
      send('done', {});

      // If the client navigated away mid-upload, still notify when ready.
      if (req.sseClosed) {
        try {
          await notifyAndStore(String(userId), {
            type: 'dataset-upload-done',
            title: 'Indexelés elkészült',
            message: `A dataset indexelés elkészült (projekt: ${projectId}, v${ds.version}).`,
            data: { projectId, datasetVersion: ds.version, files: results.map(r => ({ filename: r.filename, kind: r.kind })) },
            meta: { requestId: req.requestId, route: '/assistant', query: { projectId, datasetVersion: ds.version } },
          });
        } catch { }
      }
      return res.end();
    } catch (e) {
      try { logger.error('dataset.upload.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
      try { send('error', { error: e?.message || 'failed' }); } catch { }
      try { send('done', {}); } catch { }

      if (req?.sseClosed) {
        try {
          await notifyAndStore(String(req.userId), {
            type: 'dataset-upload-failed',
            title: 'Indexelés sikertelen',
            message: `A dataset indexelés sikertelen: ${e?.message || 'Ismeretlen hiba'}`,
            data: { projectId: req.params?.projectId || null, datasetVersion: req.params?.version || null },
            meta: { requestId: req?.requestId, route: '/assistant', query: { projectId: req.params?.projectId || null, datasetVersion: req.params?.version || null } },
          });
        } catch { }
      }
      return res.end();
    }
  }
];

exports.setDatasetFileApproval = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.userId;
    const projectId = requireProjectId(req);
    const { datasetFileId } = req.params;
    const approve = String(req.body?.approve || '').toLowerCase() === 'true' || req.body?.approve === true;

    const file = await DatasetFile.findOne({ _id: datasetFileId, tenantId, projectId });
    if (!file) return res.status(404).json({ ok: false, error: 'file not found' });

    await DatasetFile.updateOne(
      { _id: file._id },
      {
        $set: {
          approvalStatus: approve ? 'approved' : 'rejected',
          approvedBy: userId,
          approvedAt: new Date(),
        }
      }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.deleteDatasetFile = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const projectId = requireProjectId(req);
    const { datasetFileId } = req.params;
    const file = await DatasetFile.findOne({ _id: datasetFileId, tenantId, projectId });
    if (!file) return res.status(404).json({ ok: false, error: 'file not found' });
    try {
      logger.info('dataset.file.delete', {
        requestId: req.requestId,
        tenantId: String(tenantId || ''),
        projectId,
        datasetFileId: String(datasetFileId),
        datasetVersion: file.datasetVersion,
        filename: file.filename,
      });
    } catch { }
    await deleteDatasetFileArtifacts({ tenantId, projectId, datasetFileId: file._id, datasetVersion: file.datasetVersion });
    await DatasetFile.deleteOne({ _id: file._id });
    return res.json({ ok: true });
  } catch (e) {
    try { logger.error('dataset.file.delete.error', { requestId: req?.requestId, error: e?.message || 'failed' }); } catch { }
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};

exports.approveDatasetVersion = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.userId;
    const projectId = requireProjectId(req);
    const datasetVersion = Number(req.params.version);
    const ds = await Dataset.findOne({ tenantId, projectId, version: datasetVersion });
    if (!ds) return res.status(404).json({ ok: false, error: 'dataset not found' });

    const pending = await DatasetFile.countDocuments({ tenantId, projectId, datasetVersion, approvalStatus: 'pending' });
    if (pending) return res.status(409).json({ ok: false, error: 'some files are still pending review' });

    const anyApproved = await DatasetFile.exists({ tenantId, projectId, datasetVersion, approvalStatus: 'approved' });
    if (!anyApproved) return res.status(409).json({ ok: false, error: 'no approved files in this dataset version' });

    await Dataset.updateOne(
      { _id: ds._id },
      { $set: { status: 'approved', approvedBy: userId, approvedAt: new Date() } }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'failed' });
  }
};
