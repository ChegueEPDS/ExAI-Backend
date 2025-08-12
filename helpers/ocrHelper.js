const DocumentIntelligence = require("@azure-rest/ai-document-intelligence").default;
const { getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");

async function uploadPdfWithFormRecognizerInternal(pdfBuffer) {
  const endpoint = process.env.AZURE_FORM_RECOGNIZER_ENDPOINT;
  const key = process.env.AZURE_FORM_RECOGNIZER_KEY;

  if (!endpoint || !key) {
    throw new Error('Azure Form Recognizer config missing');
  }

  const client = DocumentIntelligence(endpoint, { key });

  const initialResponse = await client
    .path("/documentModels/{modelId}:analyze", "prebuilt-read")
    .post({ contentType: "application/pdf", body: pdfBuffer });

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

  return { recognizedText: extractedText, extractedData };
}

module.exports = { uploadPdfWithFormRecognizerInternal };