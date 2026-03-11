// controllers/trainingController.js
const multer = require('multer');
const mongoose = require('mongoose');
const crypto = require('crypto');

const azureBlob = require('../services/azureBlobService');
const { parseCandidatesFromXlsxBuffer } = require('../services/trainingXlsxParser');
const { generateRotDocxBuffer } = require('../services/rotDocxGenerator');
const JSZip = require('jszip');

const TrainingSettings = require('../models/trainingSettings');
const IecExTrainingUnit = require('../models/iecexTrainingUnit');
const Training = require('../models/training');
const TrainingCandidate = require('../models/trainingCandidate');
const TrainingRecordCounter = require('../models/trainingRecordCounter');
const { convertDocxBufferToPdfBuffer } = require('../services/graphDocxToPdfService');
const { stampPdfWithQr } = require('../services/pdfQrStampService');
const systemSettings = require('../services/systemSettingsStore');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(v) ? v : fallback;
}

function getQrStampOptions() {
  const size = Number(systemSettings.getNumber('QR_STAMP_SIZE') ?? 60);
  const marginX = Number(systemSettings.getNumber('QR_STAMP_MARGIN_X') ?? 50);
  const marginY = Number(systemSettings.getNumber('QR_STAMP_MARGIN_Y') ?? 100);
  const labelFontSize = Number(systemSettings.getNumber('QR_STAMP_NOTE_FONT_SIZE') ?? 8);

  return {
    size: Math.max(24, Math.min(size || 60, 240)),
    position: 'bottom-left',
    marginX: Math.max(0, marginX || 0),
    marginY: Math.max(0, marginY || 0),
    addLabel: true,
    labelFontSize: Math.max(6, Math.min(labelFontSize || 8, 16)),
  };
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = Number.parseFloat(String(raw).trim());
  return Number.isFinite(v) ? v : fallback;
}

function getSignatureWatermarkOptions({ training, candidate }) {
  const enabled = String(process.env.SIGN_WM_ENABLED || '').trim().toLowerCase() === 'true';
  if (!enabled) return { enabled: false };

  const recordNo = String(training?.recordOfTrainingNo || '').trim();
  const fullName = `${String(candidate?.lastName || '').trim()} ${String(candidate?.givenNames || '').trim()}`.trim();
  const pieces = [recordNo, fullName, 'Valid only with QR verification'].filter(Boolean);

  return {
    enabled: true,
    text: pieces.join(' • '),
    position: String(process.env.SIGN_WM_POSITION || 'bottom-right'),
    marginX: envInt('SIGN_WM_MARGIN_X', 36),
    marginY: envInt('SIGN_WM_MARGIN_Y', 72),
    maxWidth: envInt('SIGN_WM_MAX_WIDTH', 260),
    fontSize: envInt('SIGN_WM_FONT_SIZE', 9),
    opacity: envFloat('SIGN_WM_OPACITY', 0.25),
    rotateDeg: envFloat('SIGN_WM_ROTATE_DEG', -18)
  };
}

function safeSegment(input, maxLen = 120) {
  const s = String(input || '').trim();
  if (!s) return '';
  const cleaned = s
    .replace(/[^\p{L}\p{N}._-]+/gu, '-') // unicode letters/numbers
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLen) || 'item';
}

function toFolderName(name) {
  const base = safeSegment(name, 160).toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base || 'training'}-${ts}`;
}

function asYmd(s) {
  const v = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Invalid date format (expected YYYY-MM-DD): ${v}`);
  return v;
}

function yearFromYmdOrNow(ymd) {
  const v = String(ymd || '').trim();
  const m = v.match(/^(\d{4})-\d{2}-\d{2}$/);
  const y = m ? Number(m[1]) : new Date().getFullYear();
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

function pad4(n) {
  const x = Number(n || 0);
  const s = Number.isFinite(x) ? String(Math.max(0, Math.floor(x))) : '0';
  return s.padStart(4, '0').slice(-4);
}

function formatRecordOfTrainingNo(year, seq) {
  const yy = String(year).slice(-2);
  return `IECEx RT IDX${yy}.${pad4(seq)}`;
}

async function computeExistingMaxSeq({ tenantId, year }) {
  const yy = String(year).slice(-2);
  const re = new RegExp(`^IECEx RT IDX${yy}\\.(\\d{4})$`);
  const q = { recordOfTrainingNo: re };
  if (mongoose.Types.ObjectId.isValid(tenantId)) q.createdByTenantId = tenantId;
  const last = await Training.findOne(q).sort({ recordOfTrainingNo: -1 }).select({ recordOfTrainingNo: 1 }).lean();
  if (!last?.recordOfTrainingNo) return 0;
  const mm = String(last.recordOfTrainingNo).match(re);
  if (!mm) return 0;
  const n = Number(mm[1]);
  return Number.isFinite(n) ? n : 0;
}

async function allocateRecordOfTrainingNo({ tenantKey, tenantId, year }) {
  const existingMax = await computeExistingMaxSeq({ tenantId, year });
  // 1) Ensure counter exists and catches up to any existing trainings (manual overrides, legacy data).
  await TrainingRecordCounter.findOneAndUpdate(
    { tenantKey, year },
    { $setOnInsert: { lastSeq: 0 }, $max: { lastSeq: existingMax } },
    { upsert: true, new: false }
  );
  // 2) Atomically increment to reserve the next value.
  const doc = await TrainingRecordCounter.findOneAndUpdate(
    { tenantKey, year },
    { $inc: { lastSeq: 1 } },
    { new: true }
  ).lean();
  const seq = doc?.lastSeq || existingMax + 1;
  return formatRecordOfTrainingNo(year, seq);
}

async function peekNextRecordOfTrainingNo({ tenantKey, tenantId, year }) {
  const [counter, existingMax] = await Promise.all([
    TrainingRecordCounter.findOne({ tenantKey, year }).select({ lastSeq: 1 }).lean(),
    computeExistingMaxSeq({ tenantId, year })
  ]);
  const lastSeq = Math.max(Number(counter?.lastSeq || 0), Number(existingMax || 0));
  if (counter && lastSeq > Number(counter?.lastSeq || 0)) {
    // Keep counter in sync even if records were created manually or existed before counters.
    await TrainingRecordCounter.findOneAndUpdate(
      { tenantKey, year },
      { $max: { lastSeq } },
      { upsert: true, new: false }
    );
  }
  return formatRecordOfTrainingNo(year, lastSeq + 1);
}

async function getTemplateSettings() {
  const doc = await TrainingSettings.findOne({ key: 'rot' }).lean();
  return doc || null;
}

exports.upload = upload;

// --- Settings: ROT template ---
exports.getTrainingSettings = async (req, res) => {
  const s = await getTemplateSettings();
  return res.json({ ok: true, settings: s });
};

exports.uploadRotTemplate = [
  upload.single('template'),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'Missing template file' });
      const originalName = file.originalname || 'template.docx';
      const blobPath = `index/trainings/_template/${Date.now()}-${safeSegment(originalName, 140)}.docx`;

      await azureBlob.uploadBuffer(blobPath, file.buffer, file.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      const updated = await TrainingSettings.findOneAndUpdate(
        { key: 'rot' },
        {
          $set: {
            templateDocx: {
              originalName,
              blobPath,
              blobUrl: azureBlob.getBlobUrl(blobPath)
            },
            updatedByUserId: mongoose.Types.ObjectId.isValid(req.scope?.userId) ? req.scope.userId : null
          }
        },
        { upsert: true, new: true }
      ).lean();

      return res.json({ ok: true, settings: updated });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to upload template' });
    }
  }
];

// --- Settings: IECEx units CRUD ---
exports.listUnits = async (_req, res) => {
  const items = await IecExTrainingUnit.find({}).sort({ code: 1 }).lean();
  return res.json({ ok: true, items });
};

exports.createUnit = async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const title = String(req.body?.title || '').trim();
    const standard = String(req.body?.standard || '').trim();
    const trainingType = String(req.body?.trainingType || 'Full').trim();
    if (!code || !title) return res.status(400).json({ ok: false, error: 'Missing code/title' });
    const created = await IecExTrainingUnit.create({ code, title, standard, trainingType });
    return res.json({ ok: true, item: created.toJSON() });
  } catch (e) {
    const msg = /duplicate key/i.test(String(e?.message || '')) ? 'Unit code already exists' : (e?.message || 'Failed to create unit');
    return res.status(400).json({ ok: false, error: msg });
  }
};

exports.updateUnit = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const patch = {};
    for (const k of ['code', 'title', 'standard', 'trainingType', 'active']) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
    }
    if (patch.code) patch.code = String(patch.code).trim().toUpperCase();
    if (patch.title) patch.title = String(patch.title).trim();
    if (patch.standard !== undefined) patch.standard = String(patch.standard || '').trim();
    if (patch.trainingType) patch.trainingType = String(patch.trainingType).trim();

    const updated = await IecExTrainingUnit.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    if (!updated) return res.status(404).json({ ok: false, error: 'Unit not found' });
    return res.json({ ok: true, item: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'Failed to update unit' });
  }
};

exports.deleteUnit = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const resp = await IecExTrainingUnit.deleteOne({ _id: id });
  return res.json({ ok: true, deleted: resp.deletedCount || 0 });
};

// --- Trainings ---
exports.listTrainings = async (_req, res) => {
  const items = await Training.find({}).sort({ createdAt: -1 }).limit(200).lean();
  return res.json({ ok: true, items });
};

exports.getTraining = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const training = await Training.findById(id).lean();
  if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });
  const candidates = await TrainingCandidate.find({ trainingId: id }).sort({ rowNo: 1, createdAt: 1 }).lean();
  return res.json({ ok: true, training, candidates });
};

exports.getXlsxDownloadUrl = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const training = await Training.findById(id).lean();
  if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });
  const blobPath = training?.sourceXlsx?.blobPath || '';
  if (!blobPath) return res.status(404).json({ ok: false, error: 'XLSX not available' });

  const url = await azureBlob.getReadSasUrl(blobPath, {
    ttlSeconds: 600,
    filename: training?.sourceXlsx?.originalName || 'candidates.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  return res.json({ ok: true, url });
};

exports.getNextRecordOfTrainingNo = async (req, res) => {
  try {
    const dateOfIssue = String(req.query?.dateOfIssue || '').trim();
    const year = yearFromYmdOrNow(dateOfIssue);
    const tenantId = req.scope?.tenantId || null;
    const tenantKey = String(tenantId || req.scope?.tenantName || 'global');
    const next = await peekNextRecordOfTrainingNo({ tenantKey, tenantId, year });
    return res.json({ ok: true, year, next });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || 'Failed to compute next record number' });
  }
};

exports.createTraining = [
  upload.single('xlsx'),
  async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const dateOfIssue = asYmd(req.body?.dateOfIssue);
      const validityFrom = asYmd(req.body?.validityFrom);
      const validityTo = asYmd(req.body?.validityTo);
      let recordOfTrainingNo = String(req.body?.recordOfTrainingNo || '').trim();
      const trainingLanguage = String(req.body?.trainingLanguage || 'English').trim() || 'English';
      if (!name) return res.status(400).json({ ok: false, error: 'Missing name' });

      const xlsx = req.file;
      if (!xlsx) return res.status(400).json({ ok: false, error: 'Missing XLSX file' });

      const tenantId = req.scope?.tenantId || null;
      const tenantKey = String(tenantId || req.scope?.tenantName || 'global');
      const year = yearFromYmdOrNow(dateOfIssue);

      if (!recordOfTrainingNo) {
        recordOfTrainingNo = await allocateRecordOfTrainingNo({ tenantKey, tenantId, year });
      } else {
        // Enforce uniqueness (per tenant); counter-based allocation guarantees this for auto values.
        const existing = await Training.findOne({
          createdByTenantId: mongoose.Types.ObjectId.isValid(tenantId) ? tenantId : null,
          recordOfTrainingNo
        })
          .select({ _id: 1 })
          .lean();
        if (existing?._id) return res.status(409).json({ ok: false, error: 'Record of Training No. already exists' });

        // If the manual value matches the IDXYY.XXXX scheme for the issue year, keep the counter in sync.
        const yy = String(year).slice(-2);
        const re = new RegExp(`^IECEx RT IDX${yy}\\.(\\d{4})$`);
        const mm = recordOfTrainingNo.match(re);
        if (mm) {
          const manualSeq = Number(mm[1]);
          if (Number.isFinite(manualSeq)) {
            await TrainingRecordCounter.findOneAndUpdate(
              { tenantKey, year },
              { $setOnInsert: { lastSeq: 0 }, $max: { lastSeq: manualSeq } },
              { upsert: true, new: false }
            );
          }
        }
      }

      const folderName = toFolderName(name);
      const xlsxBlobPath = `index/trainings/${folderName}/source/${Date.now()}-${safeSegment(xlsx.originalname || 'candidates', 140)}.xlsx`;
      await azureBlob.uploadBuffer(xlsxBlobPath, xlsx.buffer, xlsx.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      const { candidates, warnings } = await parseCandidatesFromXlsxBuffer(xlsx.buffer);

      const training = await Training.create({
        name,
        folderName,
        dateOfIssue,
        validityFrom,
        validityTo,
        recordOfTrainingNo,
        trainingLanguage,
        sourceXlsx: {
          originalName: xlsx.originalname || '',
          blobPath: xlsxBlobPath,
          blobUrl: azureBlob.getBlobUrl(xlsxBlobPath)
        },
        createdByUserId: mongoose.Types.ObjectId.isValid(req.scope?.userId) ? req.scope.userId : null,
        createdByTenantId: mongoose.Types.ObjectId.isValid(req.scope?.tenantId) ? req.scope.tenantId : null
      });

      if (candidates.length) {
        await TrainingCandidate.insertMany(
          candidates.map((c) => ({
            trainingId: training._id,
            rowNo: c.rowNo,
            trainingLocation: c.trainingLocation,
            givenNames: c.givenNames,
            lastName: c.lastName,
            employer: c.employer,
            country: c.country,
            email: c.email,
            passportOrId: c.passportOrId,
            phone: c.phone,
            units: (c.units || []).map((u) => ({ code: u.code, scope: u.scope }))
          })),
          { ordered: false }
        );
      }

      const created = await Training.findById(training._id).lean();
      const savedCandidates = await TrainingCandidate.find({ trainingId: training._id }).sort({ rowNo: 1 }).lean();

      return res.json({ ok: true, training: created, candidates: savedCandidates, warnings });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e?.message || 'Failed to create training' });
    }
  }
];

exports.generateRotDocs = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const training = await Training.findById(id).lean();
  if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });
  if (training.status === 'closed') return res.status(400).json({ ok: false, error: 'Training is closed' });

  const settings = await getTemplateSettings();
  const templateBlobPath = settings?.templateDocx?.blobPath || '';
  if (!templateBlobPath) {
    return res.status(400).json({
      ok: false,
      error: 'Missing ROT template. Upload it first in Trainings settings.'
    });
  }

  const templateBuffer = await azureBlob.downloadToBuffer(templateBlobPath);

  const units = await IecExTrainingUnit.find({ active: true }).lean();
  const unitMetaByCode = {};
  for (const u of units) unitMetaByCode[String(u.code || '').trim().toUpperCase()] = u;
  const templateUpdatedAt = settings?.updatedAt ? new Date(settings.updatedAt) : null;
  const unitsUpdatedAt =
    units && units.length
      ? new Date(
          Math.max(
            ...units.map((u) => {
              const d = u?.updatedAt ? new Date(u.updatedAt).getTime() : 0;
              return Number.isFinite(d) ? d : 0;
            })
          )
        )
      : null;

  const candidates = await TrainingCandidate.find({ trainingId: id }).sort({ rowNo: 1, createdAt: 1 });
  let generated = 0;
  let failed = 0;

  for (const cand of candidates) {
    try {
      const fileName = `${safeSegment(cand.lastName || 'Candidate', 60)}_${safeSegment(cand.givenNames || '', 60)}_${safeSegment(cand.passportOrId || '', 30) || Date.now()}.docx`
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
      const blobPath = `index/trainings/${training.folderName}/rot/${fileName}`;

      const docxBuf = await generateRotDocxBuffer({
        templateBuffer,
        training,
        candidate: cand.toObject ? cand.toObject() : cand,
        unitMetaByCode
      });

      await azureBlob.uploadBuffer(blobPath, docxBuf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      cand.rotDocx = {
        fileName,
        blobPath,
        blobUrl: azureBlob.getBlobUrl(blobPath)
      };
      cand.rotMeta = {
        templateUpdatedAt,
        unitsUpdatedAt,
        generatedAt: new Date()
      };
      cand.status = 'generated';
      cand.error = '';
      await cand.save();
      generated++;
    } catch (e) {
      cand.status = 'error';
      cand.error = String(e?.message || e || 'Failed to generate');
      await cand.save();
      failed++;
    }
  }

  const updatedCandidates = await TrainingCandidate.find({ trainingId: id }).sort({ rowNo: 1, createdAt: 1 }).lean();
  return res.json({ ok: true, generated, failed, candidates: updatedCandidates });
};

function computeModulesSnapshot(candidates) {
  const out = new Set();
  for (const c of candidates || []) {
    for (const u of c?.units || []) {
      const code = String(u?.code || '').trim().toUpperCase();
      if (!code) continue;
      const scope = String(u?.scope || 'both').trim().toLowerCase();
      if (scope && scope !== 'both') out.add(`${code}(${scope})`);
      else out.add(code);
    }
  }
  return Array.from(out.values()).sort((a, b) => a.localeCompare(b, 'en'));
}

exports.closeTraining = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const training = await Training.findById(id);
    if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });
    if (training.status === 'closed') {
      return res.json({ ok: true, training: training.toJSON(), alreadyClosed: true });
    }

    const candidates = await TrainingCandidate.find({ trainingId: id }).sort({ rowNo: 1, createdAt: 1 });
    if (!candidates.length) return res.status(400).json({ ok: false, error: 'No candidates found for this training' });

    const notReady = candidates.filter((c) => c.status !== 'generated' || !c.rotDocx?.blobPath);
    if (notReady.length) {
      return res.status(400).json({
        ok: false,
        error: `Cannot close training: ${notReady.length} candidate(s) are not generated.`
      });
    }

    // For each candidate: convert their DOCX to PDF (Graph app-only) and upload to blob.
    for (const cand of candidates) {
      const docxPath = cand.rotDocx.blobPath;
      const docxBuf = await azureBlob.downloadToBuffer(docxPath);
      const docxName = cand.rotDocx.fileName || 'rot.docx';
      const pdfBuf = await convertDocxBufferToPdfBuffer(docxBuf, {
        fileName: docxName,
        folderPath: `rot-convert/${training.folderName}`
      });

      const pdfName = String(docxName || 'rot.docx').replace(/\.docx$/i, '') + '.pdf';
      const pdfBlobPath = `index/trainings/${training.folderName}/final/${safeSegment(pdfName, 160)}`;

      const verifyToken =
        cand.finalPdf?.verifyToken ||
        crypto.randomBytes(24).toString('base64url');

      const publicBaseUrl = String(process.env.PUBLIC_ROT_BASE_URL || '').trim() || 'http://localhost:4200';
      const verifyUrl = `${publicBaseUrl.replace(/\/+$/, '')}/rot/${encodeURIComponent(verifyToken)}`;
      // Place QR under "Record of Training No." (tunable via env vars).
      const stampedPdfBuf = await stampPdfWithQr(pdfBuf, verifyUrl, {
        ...getQrStampOptions(),
        signatureWatermark: getSignatureWatermarkOptions({ training, candidate: cand })
      });

      cand.finalPdf = {
        fileName: pdfName,
        blobPath: pdfBlobPath,
        blobUrl: azureBlob.getBlobUrl(pdfBlobPath),
        generatedAt: new Date(),
        verifyToken
      };
      // Upload stamped PDF (overwrite same blob path)
      await azureBlob.uploadBuffer(pdfBlobPath, stampedPdfBuf, 'application/pdf');
      await cand.save();
    }

    training.status = 'closed';
    training.closedAt = new Date();
    training.closedByUserId = mongoose.Types.ObjectId.isValid(req.scope?.userId) ? req.scope.userId : null;
    training.finalModules = computeModulesSnapshot(candidates.map((c) => c.toObject()));
    await training.save();

    return res.json({ ok: true, training: training.toJSON() });
  } catch (e) {
    // Make Graph permission issues obvious (these often show up as AccessDenied).
    const msg = String(e?.message || 'Failed to close training');
    const status = Number(e?.statusCode || e?.status || 0);
    const code = String(e?.code || '');

    // Best-effort logging (useful in local dev and Azure logs).
    // Some environments route console.error into structured loggers and stringify poorly,
    // so we stringify ourselves.
    try {
      const payload = {
        message: msg,
        statusCode: status || null,
        code: code || null,
        details: e?.details || null,
        stack: e?.stack || null
      };
      // eslint-disable-next-line no-console
      console.error(`[trainings.close] failed ${JSON.stringify(payload)}`);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[trainings.close] failed (could not stringify error)');
    }

    if ((status === 401 || status === 403) || /access\s*denied/i.test(msg) || /accessdenied/i.test(code)) {
      const resp = {
        ok: false,
        error: msg || 'Graph Access denied',
        hint:
          'Graph app-only conversion needs Application permissions and admin consent (e.g. Sites.ReadWrite.All or Sites.Selected + site grant).'
      };
      if (process.env.NODE_ENV !== 'production') {
        resp.debug = { statusCode: status || null, code: code || null, details: e?.details || null };
      }
      return res.status(403).json(resp);
    }

    return res.status(500).json({ ok: false, error: msg || 'Failed to close training' });
  }
};

exports.stampFinalPdfsWithQr = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const training = await Training.findById(id).lean();
    if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });

    const candidates = await TrainingCandidate.find({ trainingId: id }).sort({ rowNo: 1, createdAt: 1 });
    if (!candidates.length) return res.status(400).json({ ok: false, error: 'No candidates found for this training' });

    const publicBaseUrl = String(process.env.PUBLIC_ROT_BASE_URL || '').trim() || 'http://localhost:4200';
    const base = publicBaseUrl.replace(/\/+$/, '');

    let stamped = 0;
    let skipped = 0;
    let missing = 0;

    for (const cand of candidates) {
      const blobPath = cand.finalPdf?.blobPath || '';
      if (!blobPath) {
        missing++;
        continue;
      }

      const verifyToken = cand.finalPdf?.verifyToken || crypto.randomBytes(24).toString('base64url');
      const verifyUrl = `${base}/rot/${encodeURIComponent(verifyToken)}`;

      // Rebuild PDF from the original generated DOCX to avoid "stacking" multiple QR stamps.
      // If DOCX is missing, fall back to stamping the existing PDF in place.
      let pdfBuf;
      if (cand.rotDocx?.blobPath) {
        const docxBuf = await azureBlob.downloadToBuffer(cand.rotDocx.blobPath);
        const docxName = cand.rotDocx.fileName || 'rot.docx';
        pdfBuf = await convertDocxBufferToPdfBuffer(docxBuf, {
          fileName: docxName,
          folderPath: `rot-convert/${training.folderName || training._id}`
        });
      } else {
        pdfBuf = await azureBlob.downloadToBuffer(blobPath);
      }

      const stampedPdfBuf = await stampPdfWithQr(pdfBuf, verifyUrl, {
        ...getQrStampOptions(),
        signatureWatermark: getSignatureWatermarkOptions({ training, candidate: cand })
      });
      await azureBlob.uploadBuffer(blobPath, stampedPdfBuf, 'application/pdf');

      if (!cand.finalPdf?.verifyToken) {
        cand.finalPdf = {
          ...(cand.finalPdf || {}),
          verifyToken,
          blobUrl: azureBlob.getBlobUrl(blobPath)
        };
        await cand.save();
      }
      stamped++;
    }

    return res.json({ ok: true, stamped, skipped, missing });
  } catch (e) {
    const msg = String(e?.message || 'Failed to stamp QR');
    try {
      // eslint-disable-next-line no-console
      console.error(`[trainings.stampQr] failed ${JSON.stringify({ message: msg, stack: e?.stack || null })}`);
    } catch {}
    return res.status(500).json({ ok: false, error: msg });
  }
};

exports.reopenTraining = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const training = await Training.findById(id);
    if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });

    if (training.status !== 'closed') {
      return res.json({ ok: true, training: training.toJSON(), alreadyOpen: true });
    }

    // Delete all final PDFs under the training's final/ prefix (best effort).
    const prefix = `index/trainings/${training.folderName}/final/`;
    await azureBlob.deletePrefix(prefix);

    // Clear candidate final PDF metadata + tokens so closing can regenerate fresh PDFs/QRs.
    await TrainingCandidate.updateMany(
      { trainingId: training._id },
      {
        $unset: { finalPdf: 1 }
      }
    );

    training.status = 'open';
    training.closedAt = null;
    training.closedByUserId = null;
    training.finalModules = [];
    training.finalPdf = {
      fileName: '',
      blobPath: '',
      blobUrl: '',
      generatedAt: null
    };
    await training.save();

    return res.json({ ok: true, training: training.toJSON() });
  } catch (e) {
    const msg = String(e?.message || 'Failed to reopen training');
    try {
      // eslint-disable-next-line no-console
      console.error(`[trainings.reopen] failed ${JSON.stringify({ message: msg, stack: e?.stack || null })}`);
    } catch {}
    return res.status(500).json({ ok: false, error: msg });
  }
};

exports.listClosedTrainings = async (_req, res) => {
  const items = await Training.find({ status: 'closed' }).sort({ closedAt: -1, createdAt: -1 }).limit(500).lean();
  return res.json({ ok: true, items });
};

exports.listDatabaseCandidates = async (_req, res) => {
  const items = await TrainingCandidate.aggregate([
    { $match: { 'finalPdf.blobPath': { $ne: '' } } },
    {
      $lookup: {
        from: 'trainings',
        localField: 'trainingId',
        foreignField: '_id',
        as: 't'
      }
    },
    { $unwind: '$t' },
    { $match: { 't.status': 'closed' } },
    {
      $project: {
        _id: 1,
        trainingId: 1,
        recordOfTrainingNo: '$t.recordOfTrainingNo',
        trainingName: '$t.name',
        validityFrom: '$t.validityFrom',
        validityTo: '$t.validityTo',
        candidateGivenNames: '$givenNames',
        candidateLastName: '$lastName',
        units: 1,
        finalPdf: 1,
        closedAt: '$t.closedAt'
      }
    },
    { $sort: { closedAt: -1, recordOfTrainingNo: -1, rowNo: 1 } },
    { $limit: 2000 }
  ]);

  return res.json({ ok: true, items });
};

exports.getCandidateFinalPdfDownloadUrl = async (req, res) => {
  const trainingId = String(req.params.id || '').trim();
  const candidateId = String(req.params.candidateId || '').trim();

  const cand = await TrainingCandidate.findOne({ _id: candidateId, trainingId }).lean();
  if (!cand) return res.status(404).json({ ok: false, error: 'Candidate not found' });
  const blobPath = cand.finalPdf?.blobPath;
  if (!blobPath) return res.status(404).json({ ok: false, error: 'Final PDF not generated yet' });

  const url = await azureBlob.getReadSasUrl(blobPath, {
    ttlSeconds: 900,
    filename: cand.finalPdf?.fileName || 'rot.pdf',
    contentType: 'application/pdf'
  });
  return res.json({ ok: true, url });
};

exports.getFinalPdfDownloadUrl = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const training = await Training.findById(id).lean();
  if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });
  return res.status(400).json({ ok: false, error: 'Training-level PDF not used. Use candidate PDF endpoint.' });
};

exports.getCandidateDownloadUrl = async (req, res) => {
  const trainingId = String(req.params.id || '').trim();
  const candidateId = String(req.params.candidateId || '').trim();

  const cand = await TrainingCandidate.findOne({ _id: candidateId, trainingId }).lean();
  if (!cand) return res.status(404).json({ ok: false, error: 'Candidate not found' });
  const blobPath = cand.rotDocx?.blobPath;
  if (!blobPath) return res.status(404).json({ ok: false, error: 'DOCX not generated yet' });

  const url = await azureBlob.getReadSasUrl(blobPath, {
    ttlSeconds: 600,
    filename: cand.rotDocx?.fileName || 'rot.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  return res.json({ ok: true, url });
};

exports.generateRotZip = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const training = await Training.findById(id).lean();
    if (!training) return res.status(404).json({ ok: false, error: 'Training not found' });

    const candidates = await TrainingCandidate.find({ trainingId: id }).lean();
    const docxItems = candidates
      .filter((c) => c?.status === 'generated' && c?.rotDocx?.blobPath)
      .map((c) => ({ blobPath: c.rotDocx.blobPath, fileName: c.rotDocx.fileName || 'rot.docx' }));

    const includePdfs = training.status === 'closed';
    const pdfItems = includePdfs
      ? candidates
          .filter((c) => c?.finalPdf?.blobPath)
          .map((c) => ({ blobPath: c.finalPdf.blobPath, fileName: c.finalPdf.fileName || 'rot.pdf' }))
      : [];

    if (!docxItems.length && !pdfItems.length) {
      return res.status(400).json({ ok: false, error: 'No generated files found for this training.' });
    }

    function normalizeZipName(fileName, fallback) {
      const raw = String(fileName || '').trim() || fallback;
      const ext = raw.includes('.') ? raw.slice(raw.lastIndexOf('.')) : '';
      const base = ext ? raw.slice(0, -ext.length) : raw;
      const safeBase = safeSegment(base, 160) || safeSegment(fallback, 40) || 'file';
      const safeExt = ext && ext.length <= 10 ? ext : '';
      return `${safeBase}${safeExt}`;
    }

    const zip = new JSZip();

    // Keep backward-compatible structure for "open" trainings (DOCX in root).
    // When closed, also include PDFs under /pdf and place DOCX under /docx to avoid name collisions.
    for (const it of docxItems) {
      const buf = await azureBlob.downloadToBuffer(it.blobPath);
      const name = normalizeZipName(it.fileName, 'rot.docx');
      zip.file(includePdfs ? `docx/${name}` : name, buf);
    }

    for (const it of pdfItems) {
      const buf = await azureBlob.downloadToBuffer(it.blobPath);
      const name = normalizeZipName(it.fileName, 'rot.pdf');
      zip.file(`pdf/${name}`, buf);
    }

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipName = `ROT_${training.folderName || safeSegment(training.name, 80)}_${includePdfs ? 'FINAL_' : ''}${Date.now()}.zip`;
    const zipBlobPath = `index/trainings/${training.folderName}/rot/${zipName}`;
    await azureBlob.uploadBuffer(zipBlobPath, zipBuf, 'application/zip');

    const url = await azureBlob.getReadSasUrl(zipBlobPath, {
      ttlSeconds: 900,
      filename: zipName,
      contentType: 'application/zip'
    });

    return res.json({ ok: true, url, blobPath: zipBlobPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to generate ZIP' });
  }
};
