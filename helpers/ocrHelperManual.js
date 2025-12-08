const DocumentIntelligence = require("@azure-rest/ai-document-intelligence").default;
const { isUnexpected } = require("@azure-rest/ai-document-intelligence");
const axios = require('axios');

// --- Normalize Ex marking OCR quirks (℃, Il, lI, etc.) ---
function normalizeExmarking(value) {
  if (!value || typeof value !== 'string') return value;
  let fixed = value.toString();
  // 1) °℃ -> °C
  fixed = fixed.replace(/°℃/g, '°C');
  // 2) orphan ℃ -> °C (only if not preceded by °)
  fixed = fixed.replace(/([^°])℃/g, '$1°C');
  // 3) Il / lI -> II
  fixed = fixed.replace(/Il/g, 'II').replace(/lI/g, 'II');
  return fixed.trim();
}

async function uploadPdfWithFormRecognizerInternal(input) {
  const endpoint = process.env.AZURE_FORM_RECOGNIZER_ENDPOINT;
  const key = process.env.AZURE_FORM_RECOGNIZER_KEY;

  if (!endpoint || !key) {
    throw new Error('Azure Form Recognizer config missing');
  }

  const client = DocumentIntelligence(endpoint, { key });
  console.info(JSON.stringify({
    level: 'info',
    message: '[FormRecognizer] Starting analysis',
    endpoint,
    mode: (input && typeof input === 'object' && input.sourceUrl) ? 'url' : (typeof input === 'string' && /^https?:\/\//i.test(input) ? 'url-string' : 'buffer')
  }));

  // Decide input mode:
  // - If input is an object with { sourceUrl }, use URL mode.
  // - If input is a string that looks like a URL, use URL mode.
  // - Otherwise treat as Buffer (backward compatible with previous signature).
  let initialResponse;
  if (input && typeof input === 'object' && input.sourceUrl) {
    // URL mode via urlSource (SAS/pubic HTTPS)
    initialResponse = await client
      .path("/documentModels/{modelId}:analyze", "prebuilt-read")
      .post({ contentType: "application/json", body: { urlSource: input.sourceUrl } });
  } else if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    initialResponse = await client
      .path("/documentModels/{modelId}:analyze", "prebuilt-read")
      .post({ contentType: "application/json", body: { urlSource: input } });
  } else {
    // Buffer mode (legacy / backward compatible)
    const pdfBuffer = input;
    initialResponse = await client
      .path("/documentModels/{modelId}:analyze", "prebuilt-read")
      .post({ contentType: "application/pdf", body: pdfBuffer });
  }

  console.info(JSON.stringify({
    level: 'info',
    message: '[FormRecognizer] Initial response',
    status: initialResponse?.status,
    headers: initialResponse?.headers
  }));

  if (isUnexpected(initialResponse)) {
    throw new Error(`Azure error: ${initialResponse.body?.error?.message}`);
  }

  const operationLocation =
    initialResponse?.headers?.['operation-location'] ||
    initialResponse?.headers?.['Operation-Location'];
  if (!operationLocation) {
    throw new Error('Form Recognizer: missing operation-location header');
  }

  console.info(JSON.stringify({
    level: 'info',
    message: '[FormRecognizer] Manual polling start',
    operationLocation
  }));

  const pollIntervalMs =
    Number(process.env.AZURE_FORM_RECOGNIZER_POLL_INTERVAL_MS) || 2500;
  const timeoutMs =
    Number(process.env.AZURE_FORM_RECOGNIZER_TIMEOUT_MS) || 5 * 60 * 1000;

  const pollHeaders = {
    'Ocp-Apim-Subscription-Key': key,
    Accept: 'application/json'
  };

  const pollStart = Date.now();
  let result;
  // Simple manual polling loop against the operation-location URL
  // to avoid SDK LRO issues.
  /* eslint-disable no-constant-condition */
  while (true) {
    const elapsed = Date.now() - pollStart;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Form Recognizer polling timeout after ${Math.round(elapsed / 1000)}s`
      );
    }

    let pollResp;
    try {
      pollResp = await axios.get(operationLocation, { headers: pollHeaders });
    } catch (err) {
      console.error('[FormRecognizer] Poll error', {
        message: err?.message,
        status: err?.response?.status,
        data: err?.response?.data
      });
      throw err;
    }

    const body = pollResp?.data || {};
    const status = (body.status || '').toLowerCase();

    console.info(JSON.stringify({
      level: 'info',
      message: '[FormRecognizer] Poll progress',
      status,
      httpStatus: pollResp?.status
    }));

    if (status === 'succeeded') {
      result = body.analyzeResult || body;
      console.info(JSON.stringify({
        level: 'info',
        message: '[FormRecognizer] Poll completed',
        elapsedMs: elapsed,
        status
      }));
      break;
    }

    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      console.error('[FormRecognizer] Poll failed end state', {
        status,
        errors: body.errors || body.error
      });
      throw new Error(
        `Form Recognizer failed with status ${status}: ${JSON.stringify(
          body.errors || body.error || {}
        )}`
      );
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  /* eslint-enable no-constant-condition */

  const extractedText = result?.content || '';
  const extractedData = {
    certificateNumber: extractedText.match(/(?:IECEx|ATEX)[^\s]{0,30}/i)?.[0] || null,
    manufacturer: extractedText.match(/Manufacturer:?\s*(.*)/i)?.[1]?.trim() || null,
    // stb. — bővíthető...
  };

  // Try to extract Ex marking if present and normalize common OCR issues
  const exmarkingMatch = extractedText.match(/Ex\s?[A-Za-z0-9./() \-]+/i);
  if (exmarkingMatch) {
    extractedData.exmarking = normalizeExmarking(exmarkingMatch[0]);
  } else if (extractedData.exmarking) {
    extractedData.exmarking = normalizeExmarking(extractedData.exmarking);
  }

  return { recognizedText: extractedText, extractedData };
}

module.exports = { uploadPdfWithFormRecognizerInternal };
