const DocumentIntelligence = require("@azure-rest/ai-document-intelligence").default;
const { getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");

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

  if (isUnexpected(initialResponse)) {
    throw new Error(`Azure error: ${initialResponse.body?.error?.message}`);
  }

  const poller = getLongRunningPoller(client, initialResponse);
  const result = (await poller.pollUntilDone()).body.analyzeResult;

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