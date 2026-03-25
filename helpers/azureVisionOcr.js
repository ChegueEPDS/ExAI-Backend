const axios = require('axios');
const sharp = require('sharp');

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

async function azureReadLines(buffer, { endpoint, subscriptionKey }) {
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

  return blocks.flatMap((b) => (b?.lines || []).map((l) => String(l?.text || '').trim()).filter(Boolean));
}

function clampCrop(spec, meta) {
  const safeLeft = Math.max(0, Math.min(spec.left, Math.max(0, meta.width - 1)));
  const safeTop = Math.max(0, Math.min(spec.top, Math.max(0, meta.height - 1)));
  const width = Math.max(1, Math.min(spec.width, meta.width - safeLeft));
  const height = Math.max(1, Math.min(spec.height, meta.height - safeTop));
  return { ...spec, left: safeLeft, top: safeTop, width, height };
}

function buildCropSpecs(meta) {
  const width = Number(meta?.width || 0);
  const height = Number(meta?.height || 0);
  if (!width || !height) return [{ name: 'full', left: 0, top: 0, width: 1, height: 1 }];

  const candidates = [
    { name: 'full', left: 0, top: 0, width, height },
    {
      name: 'center-wide',
      left: Math.round(width * 0.08),
      top: Math.round(height * 0.16),
      width: Math.round(width * 0.84),
      height: Math.round(height * 0.68),
    },
    {
      name: 'lower-center',
      left: Math.round(width * 0.1),
      top: Math.round(height * 0.32),
      width: Math.round(width * 0.8),
      height: Math.round(height * 0.54),
    },
  ];

  const seen = new Set();
  return candidates
    .map((c) => clampCrop(c, { width, height }))
    .filter((c) => c.width >= 64 && c.height >= 64)
    .filter((c) => {
      const key = `${c.left}:${c.top}:${c.width}:${c.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function createOcrVariants(buffer) {
  const rotatedBuffer = await sharp(buffer, { failOn: 'none' }).rotate().png().toBuffer();
  const base = sharp(rotatedBuffer, { failOn: 'none' });
  const meta = await base.metadata();
  const cropSpecs = buildCropSpecs(meta);
  const variants = [];

  for (const crop of cropSpecs) {
    const region = base.clone().extract({
      left: crop.left,
      top: crop.top,
      width: crop.width,
      height: crop.height,
    });
    const targetWidth = Math.max(1200, crop.width * 2);

    variants.push({
      name: `${crop.name}:upscaled`,
      buffer: await region
        .clone()
        .resize({ width: targetWidth, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer(),
    });
    variants.push({
      name: `${crop.name}:sharp`,
      buffer: await region
        .clone()
        .resize({ width: targetWidth, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
        .grayscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer(),
    });
  }

  return variants;
}

function scoreOcrLines(lines) {
  const text = lines.join('\n');
  const upper = text.toUpperCase();
  let score = 0;

  score += Math.min(text.length / 30, 12);
  score += Math.min(lines.length, 10);
  if (/\bEX\b/.test(upper)) score += 4;
  if (/\bI{1,3}\s*(?:M[12]|[123])\s*(?:GD|DG|G|D)\b/.test(upper)) score += 5;
  if (/\bIIA\b|\bIIB\b|\bIIC\b|\bIIIA\b|\bIIIB\b|\bIIIC\b/.test(upper)) score += 4;
  if (/\bT[1-6]\b|\bT\d{2,3}\s*°?\s*C\b/.test(upper)) score += 3;
  if (/\bGA\b|\bGB\b|\bGC\b|\bDA\b|\bDB\b|\bDC\b/.test(upper)) score += 3;
  if (/\bIP\s*[0-6X][0-9XK]?\b/.test(upper)) score += 3;
  if (/\b(?:IECEX|ATEX)\b/.test(upper)) score += 5;
  if (/\b(?:S\/N|SERIAL|TYPE|MODEL|TEMP|AMBIENT)\b/.test(upper)) score += 2;

  for (const line of lines) {
    if (/[A-Z0-9]/i.test(line) && line.length >= 6) score += 0.35;
    if (/[A-Z]{2,}\s*\d{2,}/i.test(line)) score += 0.5;
  }

  return score;
}

function isStrongDataplateRun(lines, score) {
  const text = String(Array.isArray(lines) ? lines.join('\n') : '').toUpperCase();
  const numericScore = Number(score || 0);
  if (numericScore < 24) return false;
  if (!/\bEX\b/.test(text)) return false;
  if (!/\bI{1,3}\s*(?:M[12]|[123](?:\/[123])?)\s*(?:GD|DG|G|D)\b/.test(text)) return false;
  if (!/\bIIA\b|\bIIB\b|\bIIC\b|\bIIIA\b|\bIIIB\b|\bIIIC\b/.test(text)) return false;
  if (!/\bT[1-6]\b|\bT\d{2,3}\s*°?\s*C\b/.test(text)) return false;
  return true;
}

function normalizeLineKey(line) {
  return String(line || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function lineSignalScore(line) {
  const upper = String(line || '').toUpperCase();
  let score = 0;
  if (/\bEX\b/.test(upper)) score += 3;
  if (/\bATEX\b|\bIECEX\b/.test(upper)) score += 3;
  if (/\bIP\s*[0-6X]/.test(upper)) score += 2;
  if (/\bIIA\b|\bIIB\b|\bIIC\b|\bIIIA\b|\bIIIB\b|\bIIIC\b/.test(upper)) score += 2;
  if (/\bT[1-6]\b|\bT\d{2,3}\s*°?\s*C\b/.test(upper)) score += 2;
  if (/\bSERIAL\b|\bS\/N\b|\bMODEL\b|\bTYPE\b|\bMANUFACTURER\b/.test(upper)) score += 1;
  return score;
}

function isNearDuplicateLine(a, b) {
  const ka = normalizeLineKey(a);
  const kb = normalizeLineKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 6 && kb.includes(ka)) return true;
  if (kb.length >= 6 && ka.includes(kb)) return true;
  return false;
}

function mergeOcrRuns(runs) {
  const validRuns = Array.isArray(runs) ? runs.filter((r) => Array.isArray(r?.lines) && r.lines.length) : [];
  if (!validRuns.length) return { extractedText: '', lines: [], bestRun: null };

  const sorted = [...validRuns].sort((a, b) => (b.score || 0) - (a.score || 0));
  const baseRun = sorted[0];
  const candidateRuns = sorted.slice(1, 3);
  const lines = [];

  for (const rawLine of baseRun.lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (!normalizeLineKey(line)) continue;
    lines.push(line);
  }

  for (const run of candidateRuns) {
    for (const rawLine of run.lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (lineSignalScore(line) <= 0) continue;

      const existingIdx = lines.findIndex((existing) => isNearDuplicateLine(existing, line));
      if (existingIdx >= 0) {
        if (line.length > lines[existingIdx].length + 2) lines[existingIdx] = line;
        continue;
      }

      lines.push(line);
    }
  }

  return {
    extractedText: lines.join('\n'),
    lines,
    bestRun: baseRun || null,
  };
}

async function collectOcrRuns(variants, { endpoint, subscriptionKey, concurrency = 2 } = {}) {
  const pending = Array.isArray(variants) ? [...variants] : [];
  const runs = [];
  let firstError = null;
  let stopScheduling = false;

  async function worker() {
    while (pending.length && !stopScheduling) {
      const variant = pending.shift();
      if (!variant) return;
      try {
        const lines = await azureReadLines(variant.buffer, { endpoint, subscriptionKey });
        if (!lines.length) continue;
        const run = { name: variant.name, lines, score: scoreOcrLines(lines) };
        runs.push(run);
        if (runs.length >= 2 && isStrongDataplateRun(run.lines, run.score)) {
          stopScheduling = true;
        }
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length || 1)) }, () => worker());
  await Promise.all(workers);

  return { runs, firstError };
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

  const variants = await createOcrVariants(buffer);
  const { runs, firstError } = await collectOcrRuns(variants, {
    endpoint,
    subscriptionKey,
    concurrency: 2,
  });

  if (!runs.length) {
    if (firstError) throw firstError;
    throw new Error('No text blocks found in OCR response.');
  }

  const { extractedText } = mergeOcrRuns(runs);
  const formattedText = formatDataplateText(extractedText);
  const recognizedText = `Show the dataplate information in a table format:<br><br>${formattedText.replace(/\n/g, '<br>')}`;

  return { extractedText, formattedText, recognizedText };
}

module.exports = {
  ocrImageBufferToDataplatePrompt,
  formatDataplateText,
  _internals: {
    buildCropSpecs,
    collectOcrRuns,
    createOcrVariants,
    isStrongDataplateRun,
    mergeOcrRuns,
    lineSignalScore,
    normalizeLineKey,
    scoreOcrLines,
  },
};
