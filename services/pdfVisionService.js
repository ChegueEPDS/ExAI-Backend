const { fromBuffer } = require('pdf2pic');
const logger = require('../config/logger');
const systemSettings = require('./systemSettingsStore');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

function pdfVisionEnabled() {
  return systemSettings.getBoolean('PDF_VISION_ENABLED');
}

function visionModel() {
  return systemSettings.getString('VISION_MODEL') || 'gpt-4o-mini';
}

async function analyzeImageBase64({ base64Png, prompt }) {
  const dataUrl = `data:image/png;base64,${base64Png}`;
  const respObj = await createResponse({
    model: visionModel(),
    instructions: '',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: String(prompt || 'Extract all readable text. If a diagram/table is present, describe it precisely.') },
          { type: 'input_image', image_url: dataUrl },
        ],
      }
    ],
    store: false,
    temperature: 0,
    maxOutputTokens: 2000,
    timeoutMs: 120_000,
  });
  return String(extractOutputTextFromResponse(respObj) || '').trim();
}

async function extractPdfImageTexts({ pdfBuffer, maxPages = 2, trace = null }) {
  if (!pdfVisionEnabled()) return { ok: true, skipped: true, pages: [] };
  const pages = [];

  const density = Math.max(72, Math.min(Number(systemSettings.getNumber('PDF_VISION_DENSITY') || 150), 300));
  const width = Math.max(600, Math.min(Number(systemSettings.getNumber('PDF_VISION_WIDTH') || 1400), 2400));

  // NOTE: pdf2pic requires GraphicsMagick / ImageMagick in the runtime environment.
  const converter = fromBuffer(Buffer.from(pdfBuffer), {
    density,
    format: 'png',
    width,
    height: width,
    saveFilename: `pdf_${Date.now()}`,
    savePath: '/tmp',
  });

  const prompt = [
    'Extract all readable text from this page image.',
    'If tables exist, output them row-wise (header + rows).',
    'If drawings/infographics exist, describe key labels, dimensions, and callouts.',
    'Do NOT invent values that are not visible.'
  ].join(' ');

  for (let p = 1; p <= Math.max(1, Math.min(Number(maxPages) || 2, 10)); p += 1) {
    let base64 = '';
    try {
      const r = await converter(p, { responseType: 'base64' });
      base64 = String(r?.base64 || '').trim();
    } catch (e) {
      try { logger.warn('pdf.vision.render.failed', { requestId: trace?.requestId, page: p, error: e?.message || String(e) }); } catch { }
      continue;
    }
    if (!base64) continue;

    try {
      const text = await analyzeImageBase64({ base64Png: base64, prompt });
      if (text) pages.push({ pageNo: p, text });
    } catch (e) {
      try { logger.warn('pdf.vision.analyze.failed', { requestId: trace?.requestId, page: p, error: e?.message || String(e) }); } catch { }
    }
  }

  return { ok: true, pages };
}

module.exports = {
  extractPdfImageTexts,
  pdfVisionEnabled,
};
