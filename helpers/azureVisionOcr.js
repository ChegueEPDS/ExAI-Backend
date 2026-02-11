const axios = require('axios');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 5, baseDelay = 500 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      const retriable = [408, 429, 500, 502, 503, 504].includes(status) || !status;
      if (!retriable || attempt >= retries) throw err;
      const ra = err?.response?.headers?.['retry-after'];
      let delay = ra ? Number(ra) * 1000 : baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
      delay = Math.min(delay, 8000);
      await wait(delay);
      attempt += 1;
    }
  }
}

function formatDataplateText(rawText) {
  const extractedText = String(rawText || '');
  const formattedText = extractedText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    // Normalize Celsius symbols and common OCR artifacts
    .replace(/℃/gi, '°C')
    .replace(/°\s*°\s*C/gi, '°C')
    .replace(/°\s*C/gi, '°C')
    .replace(/\bA\s*TEX\b/gi, 'ATEX')
    .replace(/\bIEC\s*EX\b/gi, 'IECEx')
    .replace(/(Ex)\s*([MN1il|]{2,3})(A|B|C)/gi, (match, ex, roman, letter) => {
      const correctedRoman = String(roman).replace(/[MN1il|]/g, 'I');
      return `${ex} ${correctedRoman}${letter}`;
    })
    .replace(/(Ex)\s*([a-z]+)([A-Z]{3})/g, '$1 $2 $3')
    .replace(/(Ex)\s*([a-z]+)/g, '$1 $2')
    .replace(/(Ex)(?!\s)(IIA|IIB|IIC|IIIA|IIIB|IIIC)/g, '$1 $2')
    .replace(/\bEx\s*-\s*(d|de|e|h|nA|p|q|ia|ib|ic|ma|mb|mc|o|s|tb|t)\b/gi, 'Ex $1')
    .replace(/(Ex)(?!\s)/gm, '$1 ')
    .replace(/\b[l1]\b/gi, 'I')
    .replace(/\b(1I|iI|Il|lI|ll)\b/gi, 'II')
    .replace(/\bI1\b/g, 'II')
    .replace(/I[1l](?=\d)/g, 'II')
    .replace(/\b(1II|IlI|lll|lIl)\b/gi, 'III')
    // Important: keep protection type "nA" (do NOT map it to IIA).
    // Only map uppercase OCR tokens (gas group confusions) without case-insensitive matching.
    .replace(/\bMA\b/g, 'IIA')
    .replace(/\bNA\b/g, 'IIA')
    .replace(/\bMB\b/g, 'IIB')
    .replace(/\bNB\b/g, 'IIB')
    .replace(/\bMC\b/g, 'IIC')
    .replace(/\bNC\b/g, 'IIC')
    .replace(/\b(NIIIA|MIIIA|MIIA)\b/gi, 'IIIA')
    .replace(/\b(NIIIB|MIIIB|MIIB)\b/gi, 'IIIB')
    .replace(/\b(NIC|MIC)\b/gi, 'IIIC')
    .replace(/\b(d|de|e|nA|p|q|ia|ib|ic|ma|mb|mc|o|s|tb|t)?([l1|I]{2,3})(A|B|C)\b/gi, (match, prefix, roman, letter) => {
      const correctedRoman = String(roman).replace(/[l1|I]/g, 'I');
      return `${prefix ? `${prefix} ` : ''}${correctedRoman}${letter}`;
    })
    .replace(/\b11\b/g, 'II')
    .replace(/\b111\b/g, 'III')
    .replace(/\b1\b/g, 'I')
    .replace(/([A-Za-z])(\d{3,4})C/g, '$1 $2°C')
    // Join known units only when they are standalone units (avoid "1998 ANN" -> "1998ANN")
    .replace(/(\d+)\s*([VAKWHz])\b/g, '$1$2')
    .replace(/IP\s*(\d[X\d])/g, 'IP$1')
    .replace(/\|T\|(\d)\|/g, 'T$1')
    .replace(/\bT\|(\d{1,3})\|/g, 'T$1')
    .replace(/\bT\|(\d{1,3})\b/g, 'T$1')
    .replace(/(Tamb .*?to .*?C)/g, '$1\n')
    .replace(/(S\/N \d+)/g, '$1\n')
    .replace(/([A-Za-z]+):\n(\d+.*)/g, '$1: $2')
    .replace(/\n(?=[a-z])/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return formattedText;
}

async function ocrImageBufferToDataplatePrompt(buffer) {
  const endpoint = process.env.AZURE_OCR_ENDPOINT;
  const subscriptionKey = process.env.AZURE_OCR_KEY;
  if (!endpoint || !subscriptionKey) {
    throw new Error('Missing Azure OCR configuration (AZURE_OCR_ENDPOINT / AZURE_OCR_KEY).');
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('ocrImageBufferToDataplatePrompt: missing image buffer.');
  }

  const response = await withRetry(
    () =>
      axios.post(
        `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`,
        buffer,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'Content-Type': 'application/octet-stream'
          },
          timeout: 30000
        }
      ),
    { retries: 5, baseDelay: 500 }
  );

  const blocks = response.data?.readResult?.blocks;
  if (!Array.isArray(blocks)) {
    throw new Error('No text blocks found in OCR response.');
  }

  const extractedText = blocks.flatMap((b) => (b?.lines || []).map((l) => l.text)).join('\n');
  const formattedText = formatDataplateText(extractedText);
  const recognizedText = `Show the dataplate information in a table format:<br><br>${formattedText.replace(/\n/g, '<br>')}`;

  return { extractedText, formattedText, recognizedText };
}

module.exports = { ocrImageBufferToDataplatePrompt, formatDataplateText };
