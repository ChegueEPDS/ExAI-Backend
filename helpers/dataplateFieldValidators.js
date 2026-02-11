const { normalizeProtectionTypes } = require('./protectionTypes');

function cleanString(v) {
  return String(v ?? '').replace(/\u0000/g, '').trim();
}

function dedupeJoin(values) {
  const out = [];
  for (const v of values) {
    const s = cleanString(v);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out.join(', ');
}

function normalizeIpRating(raw) {
  let s = cleanString(raw).toUpperCase();
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  s = s.replace(/[^A-Z0-9,;/]/g, '');
  return s;
}

function isValidIpRating(raw) {
  const s = normalizeIpRating(raw);
  if (!s) return { ok: true, value: '' };

  // Allow multiple IP values: "IP66, IP67" (common on nameplates)
  const parts = s
    .split(/[,;/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      let x = p;
      if (!x.startsWith('IP')) {
        const idx = x.indexOf('IP');
        if (idx >= 0) x = x.slice(idx);
      }
      return x;
    })
    .filter(Boolean);

  if (!parts.length) return { ok: false, value: '', reason: `Invalid IP rating: "${cleanString(raw)}"` };

  const okParts = [];
  for (const p of parts.slice(0, 4)) {
    if (/^IP[0-6X][0-9X]$/.test(p)) okParts.push(p);
    else if (p === 'IP69K') okParts.push(p);
    else return { ok: false, value: '', reason: `Invalid IP rating: "${cleanString(raw)}"` };
  }

  return { ok: true, value: okParts.join(', ') };
}

function normalizeCertificateToken(raw) {
  let s = cleanString(raw);
  if (!s) return '';
  // Remove common certificate prefixes that sometimes get glued to the issuer by OCR/LLM.
  // Examples: "CERT.CESI 03 ATEX 010" -> "CESI 03 ATEX 010"
  s = s.replace(/^\s*(?:CERT(?:IFICATE)?|CERT\.)\s*[:.\-]?\s*/i, '');
  s = s.replace(/^\s*CERT\s*/i, '');
  // Normalize common OCR spacing issues
  s = s.replace(/\bA\s*TEX\b/gi, 'ATEX');
  s = s.replace(/\bIEC\s*EX\b/gi, 'IECEx');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function looksLikeAtex(s) {
  // Examples:
  // - "BVS 14 ATEX E 1234 X"
  // - "IBEXU12ATEX1022X" (no spaces)
  const t = String(s || '').toUpperCase().replace(/\s+/g, '').trim();
  if (!t.includes('ATEX')) return false;
  // Require "YYATEX" (may be embedded in vendor prefix) and a 3+ digit sequence.
  return /\d{2}ATEX/.test(t) && /\d{3,6}/.test(t);
}

function looksLikeIecex(s) {
  // Examples: "IECEx BAS 17.0001X", "IECEx UL 19.0012"
  const t = String(s || '').replace(/\s+/g, '').trim();
  if (!/^IECEx/i.test(t)) return false;
  // Require "YY.NNNN" style somewhere (allow 3-5 digits)
  return /\d{2}\.\d{3,5}/.test(t);
}

function normalizeAndValidateCertificateNo(raw) {
  const input = cleanString(raw);
  if (!input) return { ok: true, value: '' };
  const tokens = input
    .split(/[\/,;]+/)
    .map((t) => normalizeCertificateToken(t))
    .filter(Boolean);

  const kept = [];
  const dropped = [];
  for (const t of tokens) {
    if (looksLikeAtex(t) || looksLikeIecex(t)) kept.push(t);
    else dropped.push(t);
  }

  // Prefer longer/more-specific tokens; drop tokens that are strict substrings of longer ones (ignoring whitespace).
  const compact = Array.from(new Set(kept.map((v) => cleanString(v)))).map((v) => ({
    v,
    k: String(v || '').replace(/\s+/g, '').toUpperCase(),
  }));
  compact.sort((a, b) => b.k.length - a.k.length);
  const best = [];
  for (const item of compact) {
    if (!item.k) continue;
    if (best.some((x) => x.k.includes(item.k))) continue;
    best.push(item);
  }
  best.sort((a, b) => a.v.localeCompare(b.v));

  const value = dedupeJoin(best.map((x) => x.v));
  if (!value) {
    return { ok: false, value: '', reason: `Invalid Certificate No: "${input}"` };
  }

  const warnings = [];
  if (dropped.length) warnings.push(`Certificate No: dropped invalid token(s): ${dropped.join(' | ')}`);
  return { ok: true, value, warnings };
}

function normalizeEnum(raw, allowedUpperSet) {
  const s = cleanString(raw).toUpperCase();
  if (!s) return '';
  return allowedUpperSet.has(s) ? s : '';
}

function normalizeEnvironment(raw) {
  const s = cleanString(raw).toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  // Accept G, D, GD (order-insensitive)
  if (s === 'G' || s === 'D' || s === 'GD' || s === 'DG') return s === 'DG' ? 'GD' : s;
  return '';
}

function normalizeTempClass(raw) {
  const s = cleanString(raw).toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (/^T[1-6]$/.test(s)) return s;
  // Dust surface temps: T70°C / T100C / T85°C
  if (/^T\d{2,3}(?:°?C)$/.test(s)) return s.replace(/°?C$/, '°C').replace(/°°C$/, '°C');
  return '';
}

function normalizeCelsiusInText(raw) {
  let s = cleanString(raw);
  if (!s) return '';
  s = s.replace(/℃/g, '°C');
  s = s.replace(/°\s*°\s*C/g, '°C');
  s = s.replace(/°\s*C/g, '°C');
  return s;
}

function normalizeEquipmentGroup(raw) {
  const s = cleanString(raw).toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s === 'I' || s === 'II' || s === 'III') return s;
  return '';
}

function normalizeEquipmentCategory(raw) {
  const s = cleanString(raw).toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s === 'M1' || s === 'M2') return s;
  if (s === '1' || s === '2' || s === '3') return s;
  return '';
}

function normalizeGasDustGroup(raw) {
  const s = cleanString(raw).toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  const allowed = new Set(['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC']);
  return allowed.has(s) ? s : '';
}

function normalizeEpl(raw) {
  const s = cleanString(raw);
  if (!s) return '';
  const upper = s.toUpperCase().replace(/\s+/g, '');
  const allowed = new Set(['GA', 'GB', 'GC', 'DA', 'DB', 'DC']);
  if (!allowed.has(upper)) return '';
  // Return canonical casing
  return upper[0] + upper.slice(1).toLowerCase();
}

function normalizeTypeOfProtection(raw) {
  const normalized = normalizeProtectionTypes(cleanString(raw));
  if (!normalized.length) return '';
  // Keep deterministic join
  return normalized.join('; ');
}

function extractFromMarking(marking) {
  const s = cleanString(marking);
  const upper = s.toUpperCase();

  // Group + category + environment
  // "II 3G", "II 3D", "II 2GD", "I M2", ...
  let equipmentGroup = '';
  let equipmentCategory = '';
  let environment = '';

  const m = upper.match(/\b(I{1,3})\s*(M[12]|[123])\s*(GD|DG|G|D)\b/);
  if (m) {
    equipmentGroup = m[1];
    equipmentCategory = m[2];
    environment = m[3] === 'DG' ? 'GD' : m[3];
  } else {
    const m2 = upper.match(/\b(I{1,3})\s*(M[12]|[123])\b/);
    if (m2) {
      equipmentGroup = m2[1];
      equipmentCategory = m2[2];
    }
    const env = upper.match(/\bGD\b|\bDG\b|\bG\b|\bD\b/);
    if (env) environment = env[0] === 'DG' ? 'GD' : env[0];
  }

  // Gas/Dust group tokens
  const groupTokens = [];
  const tokenRe = /\bIIIA\b|\bIIIB\b|\bIIIC\b|\bIIA\b|\bIIB\b|\bIIC\b/g;
  let mt;
  while ((mt = tokenRe.exec(upper)) !== null) groupTokens.push(mt[0]);
  let gasDustGroup = dedupeJoin(groupTokens);

  // Heuristic: recover gas group when OCR yields pipes/Is like "|| | B" after "Ex d".
  // Prefer II? based on the already-parsed equipment group (II vs III).
  if (!gasDustGroup) {
    const noisy = upper.match(/(?:\|\s*|[IL1]\s*){2,5}\s*(A|B|C)\b/);
    if (noisy) {
      const letter = noisy[1];
      if (equipmentGroup === 'II') gasDustGroup = `II${letter}`;
      else if (equipmentGroup === 'III') gasDustGroup = `III${letter}`;
    }
  }

  // Temp class tokens
  const tTokens = [];
  // Accept "T3" and glued forms like "T3Gb" (common in Ex marking lines).
  const tRe = /\bT[1-6]\b|\bT[1-6](?=(GA|GB|GC|DA|DB|DC)\b)|\bT\d{2,3}\s*°?\s*C\b/gi;
  while ((mt = tRe.exec(s)) !== null) tTokens.push(mt[0]);
  const temperatureClass = dedupeJoin(tTokens.map((x) => normalizeTempClass(x)).filter(Boolean));

  // EPL
  const eplTokens = [];
  const eplRe = /\bGA\b|\bGB\b|\bGC\b|\bDA\b|\bDB\b|\bDC\b/gi;
  while ((mt = eplRe.exec(upper)) !== null) eplTokens.push(mt[0]);
  // Also capture glued forms like "T3Gb" / "T4Db" (no word boundary before the EPL token).
  const eplGluedRe = /T[1-6]\s*(GA|GB|GC|DA|DB|DC)\b/gi;
  while ((mt = eplGluedRe.exec(upper)) !== null) eplTokens.push(mt[1]);
  const epl = dedupeJoin(eplTokens.map((x) => normalizeEpl(x)).filter(Boolean));

  // Type of protection: extract known tokens after "Ex" (avoid misreading gas group like IIA as protection)
  const protTokens = [];
  const protRe =
    /\bEx\b\s*-?\s*(d|de|e|h|na|p|q|ia|ib|ic|ma|mb|mc|o|s|t|tb|tc|td)\b/gi;
  while ((mt = protRe.exec(s)) !== null) {
    protTokens.push(mt[1]);
  }
  let protection = '';
  if (protTokens.length) {
    protection = normalizeTypeOfProtection(protTokens.join(' '));
  }

  return {
    equipmentGroup: normalizeEquipmentGroup(equipmentGroup),
    equipmentCategory: normalizeEquipmentCategory(equipmentCategory),
    environment: normalizeEnvironment(environment),
    gasDustGroup,
    temperatureClass,
    epl,
    protection,
  };
}

function validateAndCleanDataplateFields(fields) {
  const input = fields && typeof fields === 'object' ? fields : {};
  const warnings = [];
  const rejected = [];

  const out = {
    Manufacturer: cleanString(input.Manufacturer),
    'Model/Type': cleanString(input['Model/Type']),
    'Serial Number': cleanString(input['Serial Number']),
    'Equipment Type': cleanString(input['Equipment Type']) || '-',
    'IP rating': cleanString(input['IP rating']),
    'Certificate No': cleanString(input['Certificate No']),
    'Max Ambient Temp': normalizeCelsiusInText(input['Max Ambient Temp']),
    'Other Info': cleanString(input['Other Info']),
    Compliance: cleanString(input.Compliance) || 'NA',
    'Ex Marking': Array.isArray(input['Ex Marking']) ? input['Ex Marking'] : [],
  };

  // Equipment Type: avoid mis-classifying certificate numbers as type
  if (looksLikeAtex(out['Equipment Type']) || looksLikeIecex(out['Equipment Type'])) {
    warnings.push(`Equipment Type: rejected (looks like certificate number: "${out['Equipment Type']}")`);
    out['Equipment Type'] = '-';
  }

  // IP rating
  const ip = isValidIpRating(out['IP rating']);
  if (!ip.ok) {
    rejected.push({
      field: 'IP rating',
      code: 'IP_INVALID_FORMAT',
      reason: ip.reason || 'invalid_ip',
      candidate: cleanString(out['IP rating']),
      expected: 'IP[0-6X][0-9X] (optionally multiple values separated by comma/semicolon) or IP69K',
    });
    warnings.push(`IP rating: rejected (${ip.reason || 'invalid'})`);
    out['IP rating'] = '';
  } else {
    out['IP rating'] = ip.value;
  }

  // Certificate No
  const cert = normalizeAndValidateCertificateNo(out['Certificate No']);
  if (!cert.ok) {
    rejected.push({
      field: 'Certificate No',
      code: 'CERT_INVALID_FORMAT',
      reason: cert.reason || 'invalid_certificate_no',
      candidate: cleanString(out['Certificate No']),
      expected: 'ATEX (YY ATEX ... X/U) and/or IECEx (IECEx <issuer> YY.NNNN[X/U])',
    });
    warnings.push(`Certificate No: rejected (${cert.reason || 'invalid'})`);
    out['Certificate No'] = '';
  } else {
    out['Certificate No'] = cert.value;
    if (Array.isArray(cert.warnings)) warnings.push(...cert.warnings);
  }

  // Ex Marking rows: strict, drop rows that fail
  const cleanedRows = [];
  const exRows = Array.isArray(out['Ex Marking']) ? out['Ex Marking'] : [];
  let anyExRowIncomplete = false;
  let firstIncompleteMarking = '';
  let onlyMissingEplAcrossRows = true;

  for (let i = 0; i < Math.min(exRows.length, 4); i += 1) {
    const r = exRows[i] && typeof exRows[i] === 'object' ? exRows[i] : {};
    const marking = cleanString(r.Marking);
    const hasExToken = /\bEx\b/i.test(marking);
    if (!marking || !hasExToken) {
      warnings.push(`Ex Marking row ${i + 1}: rejected (missing Ex token)`);
      continue;
    }

    // Drop low-signal "markings" that are typically OCR noise / headings.
    // Examples observed in the wild: "Ex" alone, "EX cem" brand heading.
    const markingCompact = marking.replace(/\s+/g, ' ').trim();
    const markingUpper = markingCompact.toUpperCase();
    if (markingUpper === 'EX' || /^EX\s+CEM\b/.test(markingUpper)) {
      warnings.push(`Ex Marking row ${i + 1}: rejected (noise marking: "${markingCompact}")`);
      continue;
    }

    // Prefer explicit structured fields if valid; otherwise derive from the marking line.
    const derived = extractFromMarking(marking);

    const row = {
      Marking: marking,
      'Equipment Group': normalizeEquipmentGroup(r['Equipment Group']) || derived.equipmentGroup,
      'Equipment Category': normalizeEquipmentCategory(r['Equipment Category']) || derived.equipmentCategory,
      Environment: normalizeEnvironment(r.Environment) || derived.environment,
      'Type of Protection': normalizeTypeOfProtection(r['Type of Protection']) || derived.protection,
      'Gas / Dust Group': normalizeGasDustGroup(r['Gas / Dust Group']) || derived.gasDustGroup,
      'Temperature Class': normalizeTempClass(r['Temperature Class']) || derived.temperatureClass,
      'Equipment Protection Level': normalizeEpl(r['Equipment Protection Level']) || derived.epl,
    };

    const missing = [];
    if (!row['Equipment Group']) missing.push('Equipment Group');
    if (!row['Equipment Category']) missing.push('Equipment Category');
    if (!row.Environment) missing.push('Environment');
    if (!row['Type of Protection']) missing.push('Type of Protection');
    if (!row['Gas / Dust Group']) missing.push('Gas / Dust Group');
    if (!row['Temperature Class']) missing.push('Temperature Class');
    if (!row['Equipment Protection Level']) missing.push('Equipment Protection Level');
    if (missing.length) {
      warnings.push(`Ex Marking row ${i + 1}: partial (missing ${missing.join(', ')})`);
      anyExRowIncomplete = true;
      if (!firstIncompleteMarking) firstIncompleteMarking = marking;
      if (!(missing.length === 1 && missing[0] === 'Equipment Protection Level')) {
        onlyMissingEplAcrossRows = false;
      }
    }

    cleanedRows.push(row);
  }

  if (!cleanedRows.length && exRows.length) {
    rejected.push({
      field: 'Ex Marking',
      code: 'EX_MARKING_ALL_ROWS_INVALID',
      reason: 'all_rows_invalid',
      candidate: exRows
        .slice(0, 2)
        .map((r) => cleanString(r?.Marking))
        .filter(Boolean)
        .join(' | '),
      expected: 'At least one Ex marking row containing "Ex" and enough tokens to derive group/category/env/protection/gas-dust/temp/EPL.',
    });
  }

  // Do not force repair when the only missing attribute is EPL; many nameplates omit EPL explicitly.
  if (cleanedRows.length && anyExRowIncomplete && !onlyMissingEplAcrossRows) {
    rejected.push({
      field: 'Ex Marking',
      code: 'EX_MARKING_INCOMPLETE',
      reason: 'some_rows_missing_fields',
      candidate: firstIncompleteMarking,
      expected: 'Row should include group/category/env/protection/gas-dust/temp/EPL derived from the Marking line when present.',
    });
  }

  out['Ex Marking'] = cleanedRows;

  return { fields: out, warnings, rejected };
}

module.exports = {
  validateAndCleanDataplateFields,
  // exported for targeted tests
  _internals: {
    normalizeIpRating,
    isValidIpRating,
    normalizeAndValidateCertificateNo,
    looksLikeAtex,
    looksLikeIecex,
    normalizeTempClass,
    normalizeEnvironment,
  },
};
