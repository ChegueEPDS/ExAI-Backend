const { createResponse, extractOutputTextFromResponse } = require('./openaiResponses');
const systemSettings = require('../services/systemSettingsStore');
const { validateAndCleanDataplateFields } = require('./dataplateFieldValidators');
const { normalizeProtectionTypes } = require('./protectionTypes');
const logger = require('../config/logger');

function isDebugEnabled() {
  return !!systemSettings.getBoolean('DEBUG_DATAPLATE_EXTRACT');
}

function safeOneLine(v, { max = 160 } = {}) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildOcrWindowsForRepair(ocrText, rejected) {
  const ocr = String(ocrText || '');
  const rej = Array.isArray(rejected) ? rejected : [];
  const lines = ocr.split(/\r?\n/);

  const patternsByField = {
    'IP rating': [/\bIP\b/i, /\bIP\d/i],
    'Certificate No': [/\bATEX\b/i, /\bIECEx\b/i, /CERT\b/i, /\bBASEEFA\b/i, /\bLCIE\b/i, /\bTUV\b/i, /\bCESI\b/i],
    'Ex Marking': [
      /\bEx\b/i,
      /\bI{1,3}\s*\d\s*(?:GD|DG|G|D)\b/i,
      /\bII[ABC]\b/i,
      /\bIII[ABC]\b/i,
      /\bT[1-6]\b/i,
      /\bT\d{2,3}\s*°?\s*C\b/i,
    ],
    default: [],
  };

  const wantedFields = Array.from(new Set(rej.map((r) => String(r?.field || '').trim()).filter(Boolean)));
  const windows = [];

  function addWindow(tag, startIdx, endIdx) {
    const start = Math.max(0, startIdx);
    const end = Math.min(lines.length - 1, endIdx);
    if (end < start) return;
    const text = lines.slice(start, end + 1).join('\n').trim();
    if (!text) return;
    const key = `${tag}:${start}-${end}`;
    windows.push({ tag, start, end, key, text });
  }

  for (const field of wantedFields) {
    const pats = patternsByField[field] || patternsByField.default;
    if (!pats.length) continue;
    const hitIdx = [];
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      if (!l) continue;
      if (pats.some((re) => re.test(l))) hitIdx.push(i);
    }
    if (!hitIdx.length) continue;

    let start = hitIdx[0];
    let prev = hitIdx[0];
    for (let k = 1; k < hitIdx.length; k += 1) {
      const idx = hitIdx[k];
      if (idx - prev <= 2) {
        prev = idx;
        continue;
      }
      addWindow(field, start - 2, prev + 2);
      start = idx;
      prev = idx;
    }
    addWindow(field, start - 2, prev + 2);
  }

  addWindow('header', 0, Math.min(14, lines.length - 1));

  const deduped = [];
  const seen = new Set();
  for (const w of windows) {
    const sig = w.text.replace(/\s+/g, ' ').trim();
    if (!sig) continue;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(w);
  }

  const out = [];
  let totalChars = 0;
  for (const w of deduped) {
    const nextChars = w.text.length;
    if (out.length >= 8) break;
    if (totalChars + nextChars > 12000) break;
    out.push(w);
    totalChars += nextChars;
  }
  return out;
}

function textIncludes(haystack, needle) {
  const h = String(haystack || '');
  const n = String(needle || '').trim();
  if (!n) return false;
  return h.includes(n);
}

function coerceCompliance(v) {
  const s = String(v || '').trim();
  if (s === 'Passed' || s === 'Failed' || s === 'NA') return s;
  const lower = s.toLowerCase();
  if (lower.startsWith('pass')) return 'Passed';
  if (lower.startsWith('fail')) return 'Failed';
  if (lower === 'na') return 'NA';
  return 'NA';
}

function sanitizeFieldValue(v) {
  const s = String(v ?? '').replace(/\u0000/g, '').trim();
  return s;
}

function sanitizeEvidence(v) {
  const s = String(v ?? '').replace(/\u0000/g, '').trim();
  // Keep it short to avoid huge payloads on failures
  return s.length > 400 ? s.slice(0, 400) : s;
}

function enforceEvidence({ ocrText, value, evidence }) {
  // We accept values only when the evidence snippet is present in the OCR text.
  const ev = sanitizeEvidence(evidence);
  if (!ev) return '';
  // Be robust to whitespace/degree-symbol normalization and case differences in OCR.
  const hNorm = String(ocrText || '')
    .replace(/℃/g, '°C')
    .replace(/°\s*°\s*C/g, '°C')
    .replace(/\s+/g, ' ')
    .trim();
  const nNorm = String(ev || '')
    .replace(/℃/g, '°C')
    .replace(/°\s*°\s*C/g, '°C')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hNorm || !nNorm) return '';
  if (!hNorm.includes(nNorm) && !hNorm.toLowerCase().includes(nNorm.toLowerCase())) return '';
  return sanitizeFieldValue(value);
}

function normalizeExMarkingRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const next = {
    Marking: sanitizeFieldValue(r.Marking),
    'Equipment Group': sanitizeFieldValue(r['Equipment Group']),
    'Equipment Category': sanitizeFieldValue(r['Equipment Category']),
    Environment: sanitizeFieldValue(r.Environment),
    'Type of Protection': sanitizeFieldValue(r['Type of Protection']),
    'Gas / Dust Group': sanitizeFieldValue(r['Gas / Dust Group']),
    'Temperature Class': sanitizeFieldValue(r['Temperature Class']),
    'Equipment Protection Level': sanitizeFieldValue(r['Equipment Protection Level']),
  };

  // Deterministic normalization: Type of Protection to supported set (if any).
  const normalized = normalizeProtectionTypes(next['Type of Protection']);
  if (normalized.length) next['Type of Protection'] = normalized.join('; ');

  return next;
}

function dropEmptyExMarkingRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((m) =>
    Object.values(m || {}).some((v) => String(v || '').trim().length > 0)
  );
}

function extractCertificatesFromOcrText(ocrText) {
  const s = String(ocrText || '');
  const out = [];

  // Issuer + ATEX token split across lines, e.g. "CERT.CESI" + "03 ATEX 010"
  const issuerSplit = /CERT\.?\s*([A-Z]{3,10})[\s\S]{0,60}?\b(\d{2})\s*ATEX\s*([A-Z]?\s*\d{3,6})\s*([XU])?\b/gi;
  let mi;
  while ((mi = issuerSplit.exec(s.toUpperCase())) !== null) {
    const issuer = String(mi[1] || '').trim();
    const yy = String(mi[2] || '').trim();
    const rest = String(mi[3] || '').replace(/\s+/g, '').trim();
    const suffix = String(mi[4] || '').trim();
    if (issuer && yy && rest) out.push(`${issuer} ${yy} ATEX ${rest}${suffix ? ` ${suffix}` : ''}`.trim());
  }

  // IECEx tokens (keep original substring as much as possible, normalize whitespace)
  const ieRe = /\bIECEx\s*[A-Z0-9]{1,8}\s*\d{2}\.\d{3,5}[A-Z]?\b/gi;
  let m;
  while ((m = ieRe.exec(s)) !== null) {
    out.push(String(m[0]).replace(/\s+/g, ' ').trim());
  }

  // ATEX tokens (spaceful)
  const atexRe = /\b[A-Z]{2,10}\s*\d{2}\s*ATEX\s*[A-Z]?\s*\d{3,6}\s*[XU]?\b/gi;
  while ((m = atexRe.exec(s)) !== null) {
    out.push(String(m[0]).replace(/\s+/g, ' ').trim());
  }

  // ATEX tokens (no spaces, e.g. IBEXU12ATEX1022X, LCIE08ATEX6095X)
  const atexCompactRe = /\b[A-Z]{2,10}\d{2}ATEX[A-Z]?\d{3,6}[XU]?\b/g;
  while ((m = atexCompactRe.exec(s.toUpperCase())) !== null) {
    out.push(String(m[0]).trim());
  }

  const unique = [];
  const seen = new Set();
  for (const v of out) {
    const key = String(v || '').replace(/\s+/g, '').toUpperCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }

  // Prefer issuer-qualified tokens; drop tokens that are strict substrings of longer tokens (ignoring whitespace).
  const compact = unique.map((v) => ({ v, k: String(v).replace(/\s+/g, '').toUpperCase() }));
  compact.sort((a, b) => b.k.length - a.k.length);
  const kept = [];
  for (const item of compact) {
    if (kept.some((x) => x.k.includes(item.k))) continue;
    kept.push(item);
  }
  kept.sort((a, b) => a.v.localeCompare(b.v));
  return kept.map((x) => x.v).slice(0, 6);
}

function looksLikeExLine(s) {
  const t = String(s || '');
  // Accept both "Ex" and glued forms like "Exd" (common OCR).
  return /(?:\bEx\b|\bEx\s*-?\s*(?:d|de|e|h|na|p|q|ia|ib|ic|ma|mb|mc|o|s|t|tb|tc|td)\b|\bEx(?:d|de|e|h|na|p|q|ia|ib|ic|ma|mb|mc|o|s|t|tb|tc|td)\b)/i.test(
    t
  );
}

function looksLikeCategoryLine(s) {
  const t = String(s || '').toUpperCase();
  // Examples: "II 2G", "II 2D", "II 2GD", "II2G"
  return /\bI{1,3}\s*(?:M[12]|[123])\s*(?:GD|DG|G|D)\b/.test(t);
}

function looksLikeExContinuationLine(s) {
  const t = String(s || '').toUpperCase();
  if (!t) return false;
  if (/\bIP\b/.test(t)) return true;
  if (/\bIIA\b|\bIIB\b|\bIIC\b|\bIIIA\b|\bIIIB\b|\bIIIC\b/.test(t)) return true;
  if (/\bT[1-6]\b/.test(t)) return true;
  if (/\bT\d{2,3}\s*°?\s*C\b/.test(t)) return true;
  if (/\bGA\b|\bGB\b|\bGC\b|\bDA\b|\bDB\b|\bDC\b/.test(t)) return true;
  // Sometimes OCR yields "T3Gb" etc on a separate line
  if (/\bT[1-6]\s*(GA|GB|GC|DA|DB|DC)\b/.test(t)) return true;
  if (/T[1-6](GA|GB|GC|DA|DB|DC)/.test(t)) return true;
  // Roman+letter group noise like "|| | B"
  if (/(?:\|\s*){2,6}\s*[ABC]\b/.test(t)) return true;
  return false;
}

function normalizeCategoryLine(line) {
  const t = String(line || '')
    .trim()
    .replace(/I1/g, 'II')
    .replace(/Il/g, 'II')
    .replace(/lI/g, 'II');
  const u = t.toUpperCase().replace(/\s+/g, '');
  const m = u.match(/\b(I{1,3})(M[12]|[123])((?:GD|DG|G|D))\b/);
  if (!m) return '';
  const g = m[1];
  const c = m[2];
  let env = m[3];
  if (env === 'DG') env = 'GD';
  return `${g} ${c}${env}`;
}

function stitchExLines(ocrText) {
  const lines = String(ocrText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const stitched = [];
  let lastCategory = '';
  let lastCategoryIdx = -999;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    const next2 = lines[i + 2] || '';
    const next3 = lines[i + 3] || '';

    const normalizedCat = normalizeCategoryLine(line);
    if (normalizedCat) {
      lastCategory = normalizedCat;
      lastCategoryIdx = i;
    }

    // Pattern seen on some plates: "Ex" line, then category ("II 2G"), then the real Ex line ("Ex d ...") and continuation.
    // Merge into one high-signal marking and skip the standalone "Ex".
    if (String(line).trim().toUpperCase() === 'EX' && looksLikeCategoryLine(next) && looksLikeExLine(next2)) {
      const cat = normalizeCategoryLine(next) || next;
      let merged = `${cat} ${next2}`.replace(/\s+/g, ' ').trim();
      if (next3 && !looksLikeExLine(next3) && !looksLikeCategoryLine(next3) && looksLikeExContinuationLine(next3)) {
        merged = `${merged} ${next3}`.replace(/\s+/g, ' ').trim();
        i += 3;
      } else {
        i += 2;
      }
      stitched.push(merged);
      continue;
    }

    if (looksLikeCategoryLine(line) && looksLikeExLine(next)) {
      const cat = normalizeCategoryLine(line) || line;
      let merged = `${cat} ${next}`.replace(/\s+/g, ' ').trim();
      // Append continuation line if it contains gas group / temp / EPL / IP tokens.
      if (next2 && !looksLikeExLine(next2) && !looksLikeCategoryLine(next2) && looksLikeExContinuationLine(next2)) {
        merged = `${merged} ${next2}`.replace(/\s+/g, ' ').trim();
        i += 2;
      } else {
        i += 1;
      }
      stitched.push(merged);
      continue;
    }

    // If current line is an Ex line, append a continuation line (common when "Ex d" and "IIB T3Gb IP55" are split).
    if (looksLikeExLine(line) && next && !looksLikeExLine(next) && !looksLikeCategoryLine(next) && looksLikeExContinuationLine(next)) {
      // Also prepend the nearest category line if available (common on motor plates where "II2G" is far from "Ex d").
      let prefix = '';
      if (lastCategory && (i - lastCategoryIdx) <= 40) prefix = lastCategory;
      else {
        for (let j = i - 1; j >= Math.max(0, i - 40); j -= 1) {
          const cand = normalizeCategoryLine(lines[j]);
          if (cand) {
            prefix = cand;
            break;
          }
        }
      }

      const merged = `${prefix ? `${prefix} ` : ''}${line} ${next}`.replace(/\s+/g, ' ').trim();
      stitched.push(merged);
      i += 1;
      continue;
    }

    // If we have an Ex line without a category prefix, prepend the nearest recent category line.
    if (looksLikeExLine(line) && !looksLikeCategoryLine(line)) {
      let cat = '';
      // 1) Prefer the last seen category, even if it was a bit earlier (OCR lines can contain lots of noise).
      if (lastCategory && (i - lastCategoryIdx) <= 40) cat = lastCategory;
      // 2) Otherwise scan backwards for the nearest category within a window.
      if (!cat) {
        for (let j = i - 1; j >= Math.max(0, i - 40); j -= 1) {
          const cand = normalizeCategoryLine(lines[j]);
          if (cand) {
            cat = cand;
            break;
          }
        }
      }

      if (cat) stitched.push(`${cat} ${line}`.replace(/\s+/g, ' ').trim());
      else stitched.push(line);
    } else {
      stitched.push(line);
    }
  }
  return stitched;
}

function fallbackExtractExMarkingsFromOcrText(ocrText) {
  const lines = stitchExLines(ocrText);
  const picked = [];

  for (const l of lines) {
    if (!looksLikeExLine(l)) continue;
    const cleaned = l.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const upper = cleaned.toUpperCase();
    if (upper === 'EX' || /^EX\s+CEM\b/.test(upper)) continue;
    picked.push(cleaned);
  }

  // Also handle cases where Ex symbol OCR becomes just "E" on a category line followed by Ex line already stitched above.
  const unique = Array.from(new Set(picked)).slice(0, 4);
  const rows = unique.map((marking) =>
    normalizeExMarkingRow({
      Marking: marking,
      'Equipment Group': '',
      'Equipment Category': '',
      Environment: '',
      'Type of Protection': '',
      'Gas / Dust Group': '',
      'Temperature Class': '',
      'Equipment Protection Level': '',
    })
  );
  return dropEmptyExMarkingRows(rows);
}

function exMarkingQualityScore(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  let score = 0;
  for (const r of arr.slice(0, 4)) {
    const m = String(r?.Marking || '');
    const u = m.toUpperCase();
    if (u.trim() === 'EX' || /^EX\s+CEM\b/.test(u)) continue;
    if (/\bI{1,3}\s*\d\s*(?:GD|DG|G|D)\b/.test(u) || /\bI{1,3}\s*\d(?:GD|DG|G|D)\b/.test(u)) score += 2;
    if (/\bEX\b/.test(u)) score += 1;
    if (/\b(?:D|DE|E|H|NA|P|Q|IA|IB|IC|MA|MB|MC|O|S|T|TB|TC|TD)\b/.test(u)) score += 1;
    if (/\bIIA\b|\bIIB\b|\bIIC\b|\bIIIA\b|\bIIIB\b|\bIIIC\b/.test(u)) score += 2;
    if (/\bT[1-6]\b/.test(u) || /\bT\d{2,3}\s*°?\s*C\b/i.test(m)) score += 2;
    if (/\bGA\b|\bGB\b|\bGC\b|\bDA\b|\bDB\b|\bDC\b/.test(u)) score += 1;
    if (/\bIP\b/.test(u)) score += 1;
  }
  return score;
}

async function extractDataplateFieldsFromOcrText({
  ocrText,
  model = 'gpt-4o-mini',
  assistantInstructions = '',
  maxRepairIterations = null,
  trace = null,
} = {}) {
  const ocr = String(ocrText || '').trim();
  if (!ocr) return { ok: false, error: 'missing_ocr_text' };

  const requestId = trace?.requestId || null;
  const startedAt = Date.now();

  const maxItersEffective =
    typeof maxRepairIterations === 'number' && Number.isFinite(maxRepairIterations)
      ? Math.max(0, Math.min(maxRepairIterations, 10))
      : Math.max(0, Math.min(Number(systemSettings.getNumber('DATAPLATE_EXTRACT_MAX_REPAIR_ITERS') || 3), 10));

  if (isDebugEnabled()) {
    logger.info('dataplate.extract.llm.start', {
      requestId,
      model,
      maxRepairIterations: maxItersEffective,
      ocrChars: ocr.length,
      hasAssistantPersona: !!String(assistantInstructions || '').trim(),
    });
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      fields: {
        type: 'object',
        additionalProperties: false,
        properties: {
          Manufacturer: { type: 'string' },
          'Model/Type': { type: 'string' },
          'Serial Number': { type: 'string' },
          'Equipment Type': { type: 'string' },
          'IP rating': { type: 'string' },
          'Certificate No': { type: 'string' },
          'Max Ambient Temp': { type: 'string' },
          'Other Info': { type: 'string' },
          Compliance: { type: 'string' },
          'Ex Marking': {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                Marking: { type: 'string' },
                'Equipment Group': { type: 'string' },
                'Equipment Category': { type: 'string' },
                Environment: { type: 'string' },
                'Type of Protection': { type: 'string' },
                'Gas / Dust Group': { type: 'string' },
                'Temperature Class': { type: 'string' },
                'Equipment Protection Level': { type: 'string' }
              },
              required: [
                'Marking',
                'Equipment Group',
                'Equipment Category',
                'Environment',
                'Type of Protection',
                'Gas / Dust Group',
                'Temperature Class',
                'Equipment Protection Level'
              ]
            }
          }
        },
        required: [
          'Manufacturer',
          'Model/Type',
          'Serial Number',
          'Equipment Type',
          'IP rating',
          'Certificate No',
          'Max Ambient Temp',
          'Other Info',
          'Compliance',
          'Ex Marking'
        ]
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          Manufacturer: { type: 'string' },
          'Model/Type': { type: 'string' },
          'Serial Number': { type: 'string' },
          'Equipment Type': { type: 'string' },
          'IP rating': { type: 'string' },
          'Certificate No': { type: 'string' },
          'Max Ambient Temp': { type: 'string' },
          'Other Info': { type: 'string' },
          Compliance: { type: 'string' },
          'Ex Marking': {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                Marking: { type: 'string' },
                'Equipment Group': { type: 'string' },
                'Equipment Category': { type: 'string' },
                Environment: { type: 'string' },
                'Type of Protection': { type: 'string' },
                'Gas / Dust Group': { type: 'string' },
                'Temperature Class': { type: 'string' },
                'Equipment Protection Level': { type: 'string' }
              },
              required: [
                'Marking',
                'Equipment Group',
                'Equipment Category',
                'Environment',
                'Type of Protection',
                'Gas / Dust Group',
                'Temperature Class',
                'Equipment Protection Level'
              ]
            }
          }
        },
        required: [
          'Manufacturer',
          'Model/Type',
          'Serial Number',
          'Equipment Type',
          'IP rating',
          'Certificate No',
          'Max Ambient Temp',
          'Other Info',
          'Compliance',
          'Ex Marking'
        ]
      },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['fields', 'evidence', 'warnings']
  };

  const instructions = [
    assistantInstructions ? `ASSISTANT_PERSONA:\n${String(assistantInstructions || '').trim()}\n` : '',
    'You extract equipment dataplate fields from OCR text for an industrial safety system.',
    'Return STRICT JSON only (no markdown).',
    'Rules:',
    '- Do NOT invent values.',
    '- For every returned field, also return an evidence snippet copied verbatim from the OCR text.',
    '- Evidence must be an exact substring from OCR (case-sensitive where possible).',
    '- If a field is not present, output empty string and empty evidence.',
    '- For Ex Marking, output 1..4 rows if present; otherwise empty array.',
    '- Compliance: only "Passed", "Failed", or "NA". If not present, "NA".',
  ].filter(Boolean).join('\n');

  const user = [
    'OCR_TEXT:',
    '-----',
    ocr.slice(0, 120000),
    '-----',
    '',
    'Return JSON with shape:',
    '{ "fields": { ... }, "evidence": { ... }, "warnings": string[] }',
  ].join('\n');

  let respObj;
  try {
    respObj = await createResponse({
      model,
      instructions,
      input: [{ role: 'user', content: user }],
      store: false,
      temperature: 0,
      maxOutputTokens: 1500,
      textFormat: { type: 'json_schema', name: 'dataplate_fields', strict: true, schema },
      timeoutMs: 90_000,
    });
  } catch (e) {
    if (isDebugEnabled()) {
      logger.warn('dataplate.extract.llm.error', {
        requestId,
        model,
        message: safeOneLine(e?.message || String(e), { max: 400 }),
        status: e?.status || null,
      });
    }
    return { ok: false, error: e?.message || 'llm_call_failed' };
  }

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: 'invalid_json', raw: txt.slice(0, 2000) };
  }

  const fields = parsed?.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
  const evidence = parsed?.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : {};

  const out = {
    Manufacturer: enforceEvidence({ ocrText: ocr, value: fields.Manufacturer, evidence: evidence.Manufacturer }),
    'Model/Type': enforceEvidence({ ocrText: ocr, value: fields['Model/Type'], evidence: evidence['Model/Type'] }),
    'Serial Number': enforceEvidence({ ocrText: ocr, value: fields['Serial Number'], evidence: evidence['Serial Number'] }),
    'Equipment Type': enforceEvidence({ ocrText: ocr, value: fields['Equipment Type'], evidence: evidence['Equipment Type'] }) || '-',
    'IP rating': enforceEvidence({ ocrText: ocr, value: fields['IP rating'], evidence: evidence['IP rating'] }),
    'Certificate No': enforceEvidence({ ocrText: ocr, value: fields['Certificate No'], evidence: evidence['Certificate No'] }),
    'Max Ambient Temp': enforceEvidence({ ocrText: ocr, value: fields['Max Ambient Temp'], evidence: evidence['Max Ambient Temp'] }),
    'Other Info': enforceEvidence({ ocrText: ocr, value: fields['Other Info'], evidence: evidence['Other Info'] }),
    Compliance: coerceCompliance(enforceEvidence({ ocrText: ocr, value: fields.Compliance, evidence: evidence.Compliance }) || 'NA'),
    'Ex Marking': [],
  };

  const exRows = Array.isArray(fields['Ex Marking']) ? fields['Ex Marking'] : [];
  const exEvRows = Array.isArray(evidence['Ex Marking']) ? evidence['Ex Marking'] : [];

  const exOut = [];
  for (let i = 0; i < Math.min(exRows.length, 4); i += 1) {
    const row = exRows[i] || {};
    const ev = exEvRows[i] || {};

    // If the marking evidence is not found in OCR, drop the whole row.
    const markingEvidence = sanitizeEvidence(ev?.Marking);
    if (markingEvidence && !textIncludes(ocr, markingEvidence)) continue;

    const normalized = normalizeExMarkingRow({
      Marking: enforceEvidence({ ocrText: ocr, value: row.Marking, evidence: ev?.Marking }),
      'Equipment Group': enforceEvidence({ ocrText: ocr, value: row['Equipment Group'], evidence: ev?.['Equipment Group'] }),
      'Equipment Category': enforceEvidence({ ocrText: ocr, value: row['Equipment Category'], evidence: ev?.['Equipment Category'] }),
      Environment: enforceEvidence({ ocrText: ocr, value: row.Environment, evidence: ev?.Environment }),
      'Type of Protection': enforceEvidence({ ocrText: ocr, value: row['Type of Protection'], evidence: ev?.['Type of Protection'] }),
      'Gas / Dust Group': enforceEvidence({ ocrText: ocr, value: row['Gas / Dust Group'], evidence: ev?.['Gas / Dust Group'] }),
      'Temperature Class': enforceEvidence({ ocrText: ocr, value: row['Temperature Class'], evidence: ev?.['Temperature Class'] }),
      'Equipment Protection Level': enforceEvidence({ ocrText: ocr, value: row['Equipment Protection Level'], evidence: ev?.['Equipment Protection Level'] }),
    });

    exOut.push(normalized);
  }
  out['Ex Marking'] = dropEmptyExMarkingRows(exOut);

  const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.map(String).slice(0, 20) : [];

  // Deterministic cert fallback/union: LLM sometimes returns only one cert even if multiple exist in OCR.
  const certFromOcr = extractCertificatesFromOcrText(ocr);
  if (certFromOcr.length) {
    const existing = String(out['Certificate No'] || '').trim();
    const existingKeys = new Set(
      existing
        .split(/[\/,;]+/)
        .map((x) => String(x || '').replace(/\s+/g, '').toUpperCase())
        .filter(Boolean)
    );
    const merged = existing ? [existing] : [];
    let added = 0;
    for (const c of certFromOcr) {
      const key = String(c || '').replace(/\s+/g, '').toUpperCase();
      if (!key || existingKeys.has(key)) continue;
      merged.push(c);
      existingKeys.add(key);
      added += 1;
    }
    if (!existing && merged.length) {
      out['Certificate No'] = merged.join(', ');
      warnings.push('Certificate No: filled from OCR regex fallback.');
    } else if (added) {
      out['Certificate No'] = merged.join(', ');
      warnings.push('Certificate No: augmented with OCR regex fallback.');
    }
  }

  // Strict validation: prefer empty + warning over wrong values.
  let validation = validateAndCleanDataplateFields(out);
  const allWarnings = warnings.concat(validation.warnings || []).slice(0, 60);

  // Deterministic fallback: if Ex Marking is missing/invalid, try extracting lines containing "Ex" directly from OCR.
  const exRejected = Array.isArray(validation.rejected) && validation.rejected.some((r) => r?.field === 'Ex Marking');
  const currentRows = Array.isArray(validation.fields?.['Ex Marking']) ? validation.fields['Ex Marking'] : [];
  const currentScore = exMarkingQualityScore(currentRows);
  const hasLowSignalMarking = currentRows.some((r) => {
    const u = String(r?.Marking || '').trim().toUpperCase();
    return u === 'EX' || /^EX\s+CEM\b/.test(u);
  });

  // Even if validation didn't reject, a low-signal marking string ("Ex", "EX cem") is not useful for operators.
  // Prefer a stitched OCR-derived marking when it has higher quality and still validates.
  if (exRejected || hasLowSignalMarking || currentScore <= 2) {
    const fallback = fallbackExtractExMarkingsFromOcrText(ocr);
    if (fallback.length) {
      const fallbackScore = exMarkingQualityScore(fallback);
      const nextCandidate = { ...validation.fields, 'Ex Marking': fallback };
      const nextValidation = validateAndCleanDataplateFields(nextCandidate);

      const curRejectedCount = Array.isArray(validation.rejected) ? validation.rejected.length : 0;
      const nextRejectedCount = Array.isArray(nextValidation.rejected) ? nextValidation.rejected.length : 0;

      const shouldUseFallback =
        // Primary: fewer validation errors
        nextRejectedCount < curRejectedCount ||
        // Or: same validation strictness, but better marking quality
        (nextRejectedCount === curRejectedCount && fallbackScore > currentScore);

      if (isDebugEnabled()) {
        logger.info('dataplate.extract.ex.fallback', {
          requestId,
          model,
          exRejected,
          hasLowSignalMarking,
          currentScore,
          fallbackScore,
          currentMarkings: currentRows.slice(0, 4).map((r) => safeOneLine(r?.Marking, { max: 180 })),
          fallbackMarkings: fallback.slice(0, 4).map((r) => safeOneLine(r?.Marking, { max: 180 })),
          shouldUseFallback,
          curRejectedCount,
          nextRejectedCount,
        });
      }

      if (shouldUseFallback) {
        validation = nextValidation;
        allWarnings.push('Ex Marking: fallback extracted from OCR lines containing "Ex".');
      }
    }
  }

  if (isDebugEnabled()) {
    logger.info('dataplate.extract.validate', {
      requestId,
      model,
      rejectedCount: Array.isArray(validation.rejected) ? validation.rejected.length : 0,
      rejected: (Array.isArray(validation.rejected) ? validation.rejected : []).slice(0, 12).map((r) => ({
        field: r?.field,
        reason: safeOneLine(r?.reason, { max: 160 }),
        candidate: safeOneLine(r?.candidate, { max: 160 }),
      })),
      warningsCount: allWarnings.length,
      warningsPreview: allWarnings.slice(0, 6).map((w) => safeOneLine(w, { max: 240 })),
    });
  }

  // Optional iterative repair loop: try to fix only rejected fields, still evidence + strict validation gated.
  let repairedRaw = null;
  let repairedNotes = [];

  if (maxItersEffective > 0 && Array.isArray(validation.rejected) && validation.rejected.length) {
    for (let attempt = 1; attempt <= maxItersEffective; attempt += 1) {
      const rejected = validation.rejected.slice(0, 12);
      const ocrWindows = buildOcrWindowsForRepair(ocr, rejected);
      if (isDebugEnabled()) {
        logger.info('dataplate.extract.repair.start', {
          requestId,
          model,
          attempt,
          rejectedCount: rejected.length,
          rejected: rejected.map((r) => ({ field: r?.field, reason: safeOneLine(r?.reason, { max: 160 }) })),
          windows: ocrWindows.map((w) => ({ tag: w.tag, lines: `${w.start}-${w.end}`, chars: w.text.length })),
        });
      }

      const repairResult = await tryRepairRejectedFields({
        ocrText: ocr,
        ocrWindows,
        model,
        assistantInstructions,
        currentFields: validation.fields,
        rejected,
        attempt,
        trace,
      });

      if (!repairResult?.ok) {
        allWarnings.push(`Repair attempt ${attempt}: failed (${repairResult?.error || 'unknown_error'})`);
        if (isDebugEnabled()) {
          logger.warn('dataplate.extract.repair.failed', {
            requestId,
            model,
            attempt,
            error: safeOneLine(repairResult?.error || 'unknown_error', { max: 400 }),
          });
        }
        break;
      }

      repairedRaw = repairResult.raw || repairedRaw;
      if (Array.isArray(repairResult.notes) && repairResult.notes.length) {
        repairedNotes = repairedNotes.concat(repairResult.notes.map(String).slice(0, 10));
      }

      // Apply fixes with evidence enforcement
      const fixes = repairResult.fixes && typeof repairResult.fixes === 'object' ? repairResult.fixes : {};
      const ev = repairResult.evidence && typeof repairResult.evidence === 'object' ? repairResult.evidence : {};
      const rejectedFields = new Set(rejected.map((r) => String(r?.field || '').trim()).filter(Boolean));

      if (isDebugEnabled()) {
        logger.info('dataplate.extract.repair.result', {
          requestId,
          model,
          attempt,
          fixedKeys: Object.keys(fixes || {}).slice(0, 30),
          notes: (Array.isArray(repairResult.notes) ? repairResult.notes : []).slice(0, 6).map((n) => safeOneLine(n, { max: 220 })),
          diagnosis: (Array.isArray(repairResult.diagnosis) ? repairResult.diagnosis : []).slice(0, 6).map((d) => ({
            field: d?.field,
            reason_code: d?.reason_code,
            action: safeOneLine(d?.action, { max: 160 }),
          })),
        });
      }

      const nextCandidate = { ...validation.fields };
      for (const key of Object.keys(fixes)) {
        if (key === 'Ex Marking') continue;
        if (!rejectedFields.has(key)) continue;
        const repaired = enforceEvidence({ ocrText: ocr, value: fixes[key], evidence: ev[key] });
        // Important: do not wipe already-valid fields just because repair output includes empty evidence/value.
        if (repaired) nextCandidate[key] = repaired;
      }

      if (rejectedFields.has('Ex Marking') && Array.isArray(fixes['Ex Marking']) && Array.isArray(ev['Ex Marking'])) {
        const rows = [];
        const fixRows = fixes['Ex Marking'];
        const evRows = ev['Ex Marking'];
        for (let i = 0; i < Math.min(fixRows.length, 4); i += 1) {
          const row = fixRows[i] || {};
          const eRow = evRows[i] || {};
          const markingEvidence = sanitizeEvidence(eRow?.Marking);
          if (markingEvidence && !textIncludes(ocr, markingEvidence)) continue;
          rows.push(
            normalizeExMarkingRow({
              Marking: enforceEvidence({ ocrText: ocr, value: row.Marking, evidence: eRow?.Marking }),
              'Equipment Group': enforceEvidence({ ocrText: ocr, value: row['Equipment Group'], evidence: eRow?.['Equipment Group'] }),
              'Equipment Category': enforceEvidence({ ocrText: ocr, value: row['Equipment Category'], evidence: eRow?.['Equipment Category'] }),
              Environment: enforceEvidence({ ocrText: ocr, value: row.Environment, evidence: eRow?.Environment }),
              'Type of Protection': enforceEvidence({ ocrText: ocr, value: row['Type of Protection'], evidence: eRow?.['Type of Protection'] }),
              'Gas / Dust Group': enforceEvidence({ ocrText: ocr, value: row['Gas / Dust Group'], evidence: eRow?.['Gas / Dust Group'] }),
              'Temperature Class': enforceEvidence({ ocrText: ocr, value: row['Temperature Class'], evidence: eRow?.['Temperature Class'] }),
              'Equipment Protection Level': enforceEvidence({ ocrText: ocr, value: row['Equipment Protection Level'], evidence: eRow?.['Equipment Protection Level'] }),
            })
          );
        }
        nextCandidate['Ex Marking'] = dropEmptyExMarkingRows(rows);
      }

      validation = validateAndCleanDataplateFields(nextCandidate);
      allWarnings.push(`Repair attempt ${attempt}: remaining rejected fields = ${validation.rejected.length}`);
      if (isDebugEnabled()) {
        logger.info('dataplate.extract.repair.validate', {
          requestId,
          model,
          attempt,
          remainingRejectedCount: Array.isArray(validation.rejected) ? validation.rejected.length : 0,
          remainingRejected: (Array.isArray(validation.rejected) ? validation.rejected : []).slice(0, 12).map((r) => ({
            field: r?.field,
            reason: safeOneLine(r?.reason, { max: 160 }),
            candidate: safeOneLine(r?.candidate, { max: 160 }),
          })),
        });
      }
      if (!validation.rejected.length) break;
    }
  }

  if (repairedNotes.length) allWarnings.push(...repairedNotes.map((n) => `Repair note: ${n}`));
  if (isDebugEnabled()) {
    logger.info('dataplate.extract.llm.done', {
      requestId,
      model,
      ms: Date.now() - startedAt,
      warningsCount: allWarnings.length,
      finalExRows: Array.isArray(validation?.fields?.['Ex Marking']) ? validation.fields['Ex Marking'].length : 0,
      finalHasIp: !!String(validation?.fields?.['IP rating'] || '').trim(),
      finalHasCert: !!String(validation?.fields?.['Certificate No'] || '').trim(),
    });
  }
  return { ok: true, fields: validation.fields, warnings: allWarnings.slice(0, 80), raw: parsed, repairedRaw };
}

async function tryRepairRejectedFields({
  ocrText,
  ocrWindows = null,
  model,
  assistantInstructions,
  currentFields,
  rejected,
  attempt,
  trace,
} = {}) {
  const ocr = String(ocrText || '').trim();
  const rej = Array.isArray(rejected) ? rejected : [];
  if (!ocr || !rej.length) return { ok: false, error: 'missing_input' };
  const windows = Array.isArray(ocrWindows) ? ocrWindows : [];

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      diagnosis: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string' },
            reason_code: { type: 'string' },
            explanation: { type: 'string' },
            action: { type: 'string' },
          },
          required: ['field', 'reason_code', 'explanation', 'action']
        }
      },
      fixes: {
        type: 'object',
        additionalProperties: false,
        properties: {
          Manufacturer: { type: 'string' },
          'Model/Type': { type: 'string' },
          'Serial Number': { type: 'string' },
          'Equipment Type': { type: 'string' },
          'IP rating': { type: 'string' },
          'Certificate No': { type: 'string' },
          'Max Ambient Temp': { type: 'string' },
          'Other Info': { type: 'string' },
          Compliance: { type: 'string' },
          'Ex Marking': {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                Marking: { type: 'string' },
                'Equipment Group': { type: 'string' },
                'Equipment Category': { type: 'string' },
                Environment: { type: 'string' },
                'Type of Protection': { type: 'string' },
                'Gas / Dust Group': { type: 'string' },
                'Temperature Class': { type: 'string' },
                'Equipment Protection Level': { type: 'string' }
              },
              required: [
                'Marking',
                'Equipment Group',
                'Equipment Category',
                'Environment',
                'Type of Protection',
                'Gas / Dust Group',
                'Temperature Class',
                'Equipment Protection Level'
              ]
            }
          }
        },
        required: [
          'Manufacturer',
          'Model/Type',
          'Serial Number',
          'Equipment Type',
          'IP rating',
          'Certificate No',
          'Max Ambient Temp',
          'Other Info',
          'Compliance',
          'Ex Marking'
        ]
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          Manufacturer: { type: 'string' },
          'Model/Type': { type: 'string' },
          'Serial Number': { type: 'string' },
          'Equipment Type': { type: 'string' },
          'IP rating': { type: 'string' },
          'Certificate No': { type: 'string' },
          'Max Ambient Temp': { type: 'string' },
          'Other Info': { type: 'string' },
          Compliance: { type: 'string' },
          'Ex Marking': {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                Marking: { type: 'string' },
                'Equipment Group': { type: 'string' },
                'Equipment Category': { type: 'string' },
                Environment: { type: 'string' },
                'Type of Protection': { type: 'string' },
                'Gas / Dust Group': { type: 'string' },
                'Temperature Class': { type: 'string' },
                'Equipment Protection Level': { type: 'string' }
              },
              required: [
                'Marking',
                'Equipment Group',
                'Equipment Category',
                'Environment',
                'Type of Protection',
                'Gas / Dust Group',
                'Temperature Class',
                'Equipment Protection Level'
              ]
            }
          }
        },
        required: [
          'Manufacturer',
          'Model/Type',
          'Serial Number',
          'Equipment Type',
          'IP rating',
          'Certificate No',
          'Max Ambient Temp',
          'Other Info',
          'Compliance',
          'Ex Marking'
        ]
      },
      notes: { type: 'array', items: { type: 'string' } }
    },
    required: ['diagnosis', 'fixes', 'evidence', 'notes']
  };

  const rejectedFieldsSet = new Set(rej.map((r) => String(r?.field || '').trim()).filter(Boolean));

  const instructions = [
    assistantInstructions ? `ASSISTANT_PERSONA:\n${String(assistantInstructions || '').trim()}\n` : '',
    'You repair OCR-extracted equipment dataplate fields for an industrial safety system.',
    'Return STRICT JSON only (no markdown).',
    'Rules:',
    '- Do NOT invent values.',
    '- Only propose fixes for fields that failed validation.',
    '- For every fix, include an evidence snippet copied verbatim from OCR text (exact substring).',
    '- If you cannot fix a field with evidence, output empty string and empty evidence for that field.',
    '- Focus on common OCR issues (confusable characters, missing spaces, broken tokens).',
    '- Provide a diagnosis entry per rejected field with (reason_code, explanation, action).',
  ].filter(Boolean).join('\n');

  const ocrPayload =
    windows.length
      ? [
          'OCR_WINDOWS (use these; they are extracted from OCR text):',
          JSON.stringify(
            windows.map((w) => ({ tag: w.tag, lines: `${w.start}-${w.end}`, text: w.text })),
            null,
            2
          ),
        ].join('\n')
      : [
          'OCR_TEXT:',
          '-----',
          // Keep this smaller than the initial extraction request to reduce 400s on large payloads.
          ocr.slice(0, 80000),
          '-----',
        ].join('\n');

  const user = [
    `ATTEMPT: ${attempt}`,
    '',
    'REJECTED_FIELDS (field + code + reason + expected + candidate):',
    JSON.stringify(rej, null, 2),
    '',
    'CURRENT_FIELDS (after evidence gating + strict validation):',
    JSON.stringify(currentFields || {}, null, 2),
    '',
    ocrPayload,
    '',
    'Output guidance:',
    '- In fixes/evidence, keep non-target fields as empty string / empty evidence.',
    '- Only target these fields:',
    JSON.stringify(Array.from(rejectedFieldsSet), null, 2),
  ].join('\n');

  let respObj;
  try {
    respObj = await createResponse({
      model,
      instructions,
      input: [{ role: 'user', content: user }],
      store: false,
      temperature: 0,
      maxOutputTokens: 1200,
      textFormat: { type: 'json_schema', name: 'dataplate_repair', strict: true, schema },
      timeoutMs: 90_000,
    });
  } catch (e) {
    return { ok: false, error: e?.message || 'llm_call_failed' };
  }

  const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: 'invalid_json', raw: txt.slice(0, 2000) };
  }

  return {
    ok: true,
    diagnosis: Array.isArray(parsed?.diagnosis) ? parsed.diagnosis : [],
    fixes: parsed?.fixes || {},
    evidence: parsed?.evidence || {},
    notes: Array.isArray(parsed?.notes) ? parsed.notes.map(String).slice(0, 20) : [],
    raw: parsed,
  };
}

module.exports = {
  extractDataplateFieldsFromOcrText,
};
