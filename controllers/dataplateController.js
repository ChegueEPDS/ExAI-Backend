const multer = require('multer');
const logger = require('../config/logger');
const { ocrImageBufferToDataplatePrompt, formatDataplateText } = require('../helpers/azureVisionOcr');
const { extractDataplateFieldsFromOcrText } = require('../helpers/dataplateJsonExtractor');
const { resolveUserAndTenant } = require('../services/chatAccessService');
const systemSettings = require('../services/systemSettingsStore');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

function previewText(raw, { head = 1200, tail = 600 } = {}) {
  const s = String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!s) return '';
  if (s.length <= head + tail + 20) return s;
  return `${s.slice(0, head)}\n…\n${s.slice(-tail)}`;
}

function flattenExtractedFieldsToRow(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const exArr = Array.isArray(f['Ex Marking']) ? f['Ex Marking'] : [];

  const mergedKeys = [
    'Marking',
    'Equipment Group',
    'Equipment Category',
    'Environment',
    'Type of Protection',
    'Gas / Dust Group',
    'Temperature Class',
    'Equipment Protection Level',
  ];

  const merged = {};
  for (const k of mergedKeys) {
    const values = exArr.map((m) => (m && typeof m === 'object' ? String(m[k] || '').trim() : '')).filter(Boolean);
    merged[k] = Array.from(new Set(values)).join(', ');
  }

  return {
    // EqID is assigned later when saving to DB (frontend already does this)
    Manufacturer: String(f.Manufacturer || '').trim(),
    'Model/Type': String(f['Model/Type'] || '').trim(),
    'Serial Number': String(f['Serial Number'] || '').trim(),
    'Equipment Type': String(f['Equipment Type'] || '-').trim() || '-',
    'IP rating': String(f['IP rating'] || '').trim(),
    'Certificate No': String(f['Certificate No'] || '').trim(),
    'Max Ambient Temp': String(f['Max Ambient Temp'] || '').trim(),
    'Other Info': String(f['Other Info'] || '').trim(),
    Compliance: String(f.Compliance || 'NA').trim() || 'NA',
    ...merged,
  };
}

exports.uploadExtract = [
  upload.any(),
  async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'No files uploaded.' });

      const debug = !!systemSettings.getBoolean('DEBUG_DATAPLATE_EXTRACT');
      const requestId = req.requestId || null;
      const startedAt = Date.now();
      if (debug) {
        logger.info('dataplate.extract.http.start', {
          requestId,
          files: files.slice(0, 5).map((f) => ({ field: f?.fieldname, name: f?.originalname, bytes: f?.size || 0 })),
        });
      }

      // 1) OCR each image (Azure), combine text
      const ocrStartedAt = Date.now();
      const extractedParts = [];
      for (const f of files.slice(0, 5)) {
        if (!f || !Buffer.isBuffer(f.buffer) || !f.buffer.length) continue;
        const o = await ocrImageBufferToDataplatePrompt(f.buffer);
        if (o?.extractedText) extractedParts.push(String(o.extractedText));
      }
      const extractedText = extractedParts.join('\n');
      const formattedText = formatDataplateText(extractedText);
      const recognizedText = `Show the dataplate information in a table format:<br><br>${formattedText.replace(/\n/g, '<br>')}`;
      if (debug) {
        logger.info('dataplate.extract.ocr.done', {
          requestId,
          ms: Date.now() - ocrStartedAt,
          extractedParts: extractedParts.length,
          extractedChars: extractedText.length,
          formattedChars: formattedText.length,
        });
        logger.info('dataplate.extract.ocr.text', {
          requestId,
          extractedPreview: previewText(extractedText),
          formattedPreview: previewText(formattedText),
        });
      }

      // 2) Resolve tenant persona/model best-effort (only when auth context exists)
      let assistantInstructions = '';
      let model = 'gpt-4o-mini';
      try {
        if (req.userId) {
          const { tenantId } = await resolveUserAndTenant(req);
          const tenantSettingsStore = require('../services/tenantSettingsStore');
          const cfg = await tenantSettingsStore.getDataplateExtractConfig(tenantId);
          assistantInstructions = String(cfg?.extraInstructions || '').trim();
          model = String(cfg?.model || model).trim() || model;
        }
      } catch {
        // keep defaults
      }

      // 3) Structured extraction (Responses json_schema + evidence validation)
      const llmStartedAt = Date.now();
      const r = await extractDataplateFieldsFromOcrText({
        ocrText: formattedText || extractedText,
        model,
        assistantInstructions,
        trace: { requestId: req.requestId },
      });
      if (!r.ok) {
        if (debug) {
          logger.warn('dataplate.extract.http.failed', {
            requestId,
            model,
            ms: Date.now() - startedAt,
            llmMs: Date.now() - llmStartedAt,
            error: r.error || 'unknown',
          });
        }
        return res.status(502).json({
          ok: false,
          error: 'DATAPLATE_EXTRACT_FAILED',
          recognizedText,
          formattedText,
          details: r.error || 'unknown',
        });
      }

      const row = flattenExtractedFieldsToRow(r.fields);

      if (debug) {
        logger.info('dataplate.extract.http.done', {
          requestId,
          model,
          ms: Date.now() - startedAt,
          llmMs: Date.now() - llmStartedAt,
          warningsCount: Array.isArray(r.warnings) ? r.warnings.length : 0,
          warningsPreview: Array.isArray(r.warnings) ? r.warnings.slice(0, 6).map((w) => String(w || '').slice(0, 240)) : [],
          hasIp: !!String(r?.fields?.['IP rating'] || '').trim(),
          hasCert: !!String(r?.fields?.['Certificate No'] || '').trim(),
          exRows: Array.isArray(r?.fields?.['Ex Marking']) ? r.fields['Ex Marking'].length : 0,
        });
      }

      return res.json({
        ok: true,
        recognizedText,
        formattedText,
        extracted: r.fields,
        row,
        warnings: r.warnings || [],
        model,
      });
    } catch (e) {
      logger.error('dataplate.extract.error', { message: e?.message || String(e), stack: e?.stack });
      return res.status(500).json({ ok: false, error: 'Failed to extract dataplate.' });
    }
  }
];
