const crypto = require('crypto');
const OpenAI = require('openai');
const { get_encoding } = require('tiktoken');

const Standard = require('../models/standard');
const StandardClause = require('../models/standardClause');
const Tenant = require('../models/tenant');
const StandardSet = require('../models/standardSet');
const azureBlob = require('./azureBlobService');
const pinecone = require('./pineconeService');
const systemSettings = require('./systemSettingsStore');
const embeddingContext = require('./embeddingContext');
const logger = require('../config/logger');

const encoder = get_encoding('o200k_base');

function sanitizeEmbeddingInput(s) {
  const v = String(s ?? '').replace(/\u0000/g, '').trim();
  return v.length ? v : '';
}

function tokenTrim(str, maxTokens) {
  const ids = encoder.encode(String(str || ''));
  if (ids.length <= maxTokens) return String(str || '');
  return encoder.decode(ids.slice(0, maxTokens));
}

async function createEmbeddingVector(openaiClient, text, embeddingModel) {
  const input0 = sanitizeEmbeddingInput(text);
  const input = sanitizeEmbeddingInput(tokenTrim(input0, 800));
  if (!input) return [];
  const resp = await openaiClient.embeddings.create({ model: embeddingModel, input: [input] });
  return resp.data?.[0]?.embedding || [];
}

function chunkWithOverlap(text, { chunkTokens = 900, overlapTokens = 120 } = {}) {
  const ids = encoder.encode(String(text || ''));
  const chunks = [];
  if (!ids.length) return [];
  const step = Math.max(1, chunkTokens - overlapTokens);
  for (let i = 0; i < ids.length; i += step) {
    const slice = ids.slice(i, Math.min(i + chunkTokens, ids.length));
    chunks.push(encoder.decode(slice));
    if (i + chunkTokens >= ids.length) break;
  }
  return chunks;
}

function extractModeHints(text) {
  const t = String(text || '');
  const gas =
    /\bEx\s*(d|db|e|eb|p|i|m|mb)\b/i.test(t) ||
    /\b(Ga|Gb|Gc)\b/.test(t) ||
    /\b(1G|2G|3G)\b/i.test(t) ||
    /\b(IIC|IIB|IIA)\b/.test(t) ||
    /\bT[1-6]\b/.test(t) ||
    /\bT-?class\b/i.test(t);
  const dust =
    /\bEx\s*(t|tb|tc)\b/i.test(t) ||
    /\b(Da|Db|Dc)\b/.test(t) ||
    /\b(1D|2D|3D)\b/i.test(t) ||
    /\b(IIIA|IIIB|IIIC)\b/.test(t) ||
    /\bIP6X\b/i.test(t) ||
    /\bT\d{2,3}\s*°?\s*C\b/i.test(t);
  if (gas && dust) return 'both';
  if (gas) return 'gas';
  if (dust) return 'dust';
  return 'unknown';
}

function extractEntities(text) {
  const t = String(text || '');
  const out = {};
  const marking = t.match(/\bEx\s*[^\n]{0,80}/i);
  if (marking) out.ex_marking = marking[0].trim();
  const epl = t.match(/\b(Ga|Gb|Gc|Da|Db|Dc)\b/);
  if (epl) out.epl = epl[0];
  const groups = t.match(/\b(IIC|IIB|IIA|IIIA|IIIB|IIIC)\b/g);
  if (groups) out.groups = Array.from(new Set(groups));
  const tclass = t.match(/\bT[1-6]\b/);
  if (tclass) out.t_class = tclass[0];
  const ip = t.match(/\bIP\d{1,2}[A-Z]?\b/g);
  if (ip) out.ip = Array.from(new Set(ip));
  return out;
}

function parseClausesHeuristic(text) {
  const s = String(text || '').replace(/\r/g, '');
  // Very lightweight heuristic: detect headings like "6.2.3 Title"
  const re = /(^|\n)(\d+(?:\.\d+){1,5})\s+([^\n]{3,120})/g;
  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    matches.push({ idx: m.index + (m[1] ? m[1].length : 0), clauseId: m[2], title: (m[3] || '').trim() });
  }
  if (matches.length < 3) return null;

  const clauses = [];
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const next = matches[i + 1];
    const start = cur.idx;
    const end = next ? next.idx : s.length;
    const body = s.slice(start, end).trim();
    if (!body) continue;
    clauses.push({ clauseId: cur.clauseId, title: cur.title, text: body });
  }
  return clauses.length ? clauses : null;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function guessPrimaryFilenameForClauseText(clauseText, filenames) {
  const t = String(clauseText || '');
  for (const fn of (Array.isArray(filenames) ? filenames : [])) {
    if (!fn) continue;
    if (t.includes(`--- FILE: ${fn} ---`)) return fn;
    if (t.includes(`FILE=${fn}`)) return fn;
  }
  return String(filenames?.[0] || '');
}

function attachPageOrLocToHeuristicClauses(clauses, pageSegments) {
  const segs = Array.isArray(pageSegments) ? pageSegments : [];
  if (!segs.length) return clauses;

  const filenames = Array.from(new Set(segs.map(s => String(s?.filename || '').trim()).filter(Boolean)));
  if (!filenames.length) return clauses;

  // For each clauseId, find the first page that contains the clauseId marker (best-effort).
  // This preserves human clause IDs (e.g., 3.69.4) while enabling page jump in the UI.
  return (Array.isArray(clauses) ? clauses : []).map(c => {
    const clauseId = String(c?.clauseId || '').trim();
    if (!clauseId) return c;

    const fn = guessPrimaryFilenameForClauseText(c?.text, filenames) || filenames[0];
    const pages = segs.filter(s => String(s?.filename || '').trim() === fn);
    const re = new RegExp(`(^|\\n)\\s*${escapeRegex(clauseId)}(\\s|$)`, 'm');
    let foundPageNo = null;
    for (const p of pages) {
      const txt = String(p?.text || '');
      if (re.test(txt)) {
        const n = Number(p?.pageNo || 0);
        if (Number.isFinite(n) && n > 0) {
          foundPageNo = n;
          break;
        }
      }
    }
    if (!foundPageNo) return c;
    return { ...c, pageOrLoc: `${fn} page:${foundPageNo}` };
  });
}

function splitClauseByTokens({ clauseId, title, text, pageOrLoc = '' }, { maxTokens = 500, overlapTokens = 80 } = {}) {
  const ids = encoder.encode(String(text || ''));
  if (ids.length <= maxTokens) return [{ clauseId, title, text, pageOrLoc }];
  const chunks = chunkWithOverlap(text, { chunkTokens: maxTokens, overlapTokens });
  return chunks.map((t, idx) => ({
    clauseId: `${clauseId}#p${idx + 1}`,
    title,
    pageOrLoc,
    text: t,
  }));
}

function ensureUniqueClauseIds(items) {
  const seen = new Set();
  const baseCounts = new Map();
  return (Array.isArray(items) ? items : []).map((c) => {
    const original = String(c?.clauseId || '').trim() || 'chunk-unknown';
    if (!seen.has(original)) {
      seen.add(original);
      baseCounts.set(original, 1);
      return c;
    }

    let n = baseCounts.get(original) || 1;
    let next = '';
    for (let i = 0; i < 500; i += 1) {
      n += 1;
      next = `${original}#dup${n}`;
      if (!seen.has(next)) break;
    }
    baseCounts.set(original, n);
    seen.add(next);
    return { ...c, clauseId: next };
  });
}

async function extractStandardToText({ filename, contentType, buffer }) {
  const lower = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

  if (ct === 'application/pdf' || lower.endsWith('.pdf')) {
    const FormData = require('form-data');
    const axios = require('axios');
    const axiosClient = axios.create({ timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: contentType || 'application/pdf' });
    // Reuse OCR/text endpoint
    form.append('certType', 'ATEX');
    const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, { headers: form.getHeaders() });
    return {
      text: String(resp.data?.recognizedText || ''),
      pagesText: Array.isArray(resp.data?.pagesText) ? resp.data.pagesText : [],
    };
  }

  if (lower.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ buffer });
    return { text: String(r?.value || ''), pagesText: [] };
  }

  // Best-effort text
  try { return { text: Buffer.from(buffer).toString('utf8'), pagesText: [] }; } catch { return { text: '', pagesText: [] }; }
}

async function ingestStandardFiles({
  tenantId,
  createdBy,
  name,
  standardId,
  edition = '',
  files = [],
}) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!standardId) throw new Error('standardId is required');
  if (!name) throw new Error('name is required');
  if (!Array.isArray(files) || !files.length) throw new Error('no files provided');

  const std = await Standard.create({
    tenantId,
    name,
    standardId,
    edition,
    status: 'processing',
    meta: { createdBy },
  });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';
  const pineconeEnabled = pinecone.isPineconeEnabled();
  const namespace = pineconeEnabled ? pinecone.resolveNamespace({ tenantId, projectId: 'standard-library' }) : null;
  const standardChunkTokens = Number(systemSettings.getNumber('STANDARD_CHUNK_TOKENS') || 450);
  const standardChunkOverlap = Number(systemSettings.getNumber('STANDARD_CHUNK_OVERLAP') || 80);
  const standardClauseMaxTokens = Number(systemSettings.getNumber('STANDARD_CLAUSE_MAX_TOKENS') || 500);

  try {
    const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');
    if (debugEnabled) {
      try {
        logger.info('standards.ingest.start', {
          tenantId: String(tenantId || ''),
          standardRef: String(std._id),
          standardId: String(standardId || ''),
          edition: String(edition || ''),
          name,
          files: (files || []).map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
          pineconeEnabled,
          namespace,
          chunkTokens: standardChunkTokens,
          overlapTokens: standardChunkOverlap,
          clauseMaxTokens: standardClauseMaxTokens,
        });
      } catch { }
    }

    // Blob prefix: standards/{tenantName}/... (fallback: tenantId)
    let tenantName = '';
    try {
      const t = await Tenant.findById(tenantId).select('name').lean();
      tenantName = String(t?.name || '').trim();
    } catch { }
    const safeTenant =
      (tenantName ? tenantName : String(tenantId))
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || String(tenantId);

    let combined = '';
    const pageSegments = [];
    const sourceFiles = [];

    for (const f of files) {
      const filename0 = String(f.originalname || 'standard.bin');
      const contentType0 = String(f.mimetype || 'application/octet-stream');
      const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
      const blobPath = `standards/${safeTenant}/${std._id}/${Date.now()}-${sha256}-${filename0}`.replace(/\s+/g, '_');
      await azureBlob.uploadBuffer(blobPath, f.buffer, contentType0, { overwrite: true });
      sourceFiles.push({ filename: filename0, contentType: contentType0, blobPath, sha256 });

      const extracted = await extractStandardToText({ filename: filename0, contentType: contentType0, buffer: f.buffer });
      const txt = String(extracted?.text || '').trim();
      if (txt) combined += `\n\n--- FILE: ${filename0} ---\n\n${txt}`;

      const pagesText = Array.isArray(extracted?.pagesText) ? extracted.pagesText : [];
      if (pagesText.length) {
        for (let p = 0; p < pagesText.length; p += 1) {
          const pageNo = p + 1;
          const pageText = String(pagesText[p] || '').replace(/\u0000/g, '').trim();
          if (!pageText) continue;
          pageSegments.push({
            filename: filename0,
            pageNo,
            text: pageText,
            pageOrLoc: `${filename0} page:${pageNo}`,
          });
        }
      }
    }

    const clean = String(combined || '').replace(/\u0000/g, '').trim();
    if (!clean) throw new Error('extracted text is empty');

    const parsed = parseClausesHeuristic(clean);
    let clauses0;
    if (parsed) {
      clauses0 = attachPageOrLocToHeuristicClauses(parsed, pageSegments);
    } else if (pageSegments.length) {
      clauses0 = [];
      let chunkSeq = 0;
      for (const seg of pageSegments) {
        const pageChunks = chunkWithOverlap(seg.text, { chunkTokens: standardChunkTokens, overlapTokens: standardChunkOverlap }).filter(Boolean);
        for (let i = 0; i < pageChunks.length; i += 1) {
          chunkSeq += 1;
          clauses0.push({
            clauseId: `chunk-${String(chunkSeq).padStart(4, '0')}`,
            title: '',
            pageOrLoc: seg.pageOrLoc,
            text: `FILE=${seg.filename}\nPAGE=${seg.pageNo}\n\n${pageChunks[i]}`.trim(),
          });
        }
      }
    } else {
      clauses0 = chunkWithOverlap(clean, { chunkTokens: standardChunkTokens, overlapTokens: standardChunkOverlap }).map((t, i) => ({
        clauseId: `chunk-${String(i + 1).padStart(4, '0')}`,
        title: '',
        pageOrLoc: `chunk:${i + 1}`,
        text: t,
      }));
    }

    // Split long clauses into smaller parts for better compliance precision.
    const clauses = [];
    for (const c of clauses0) {
      const parts = splitClauseByTokens(c, { maxTokens: standardClauseMaxTokens, overlapTokens: standardChunkOverlap });
      clauses.push(...parts);
    }

    const maxClauses = Number(systemSettings.getNumber('STANDARD_MAX_CLAUSES') || 1200);
    const toIndex = ensureUniqueClauseIds(clauses).slice(0, maxClauses);
    if (debugEnabled) {
      try {
        logger.info('standards.ingest.parsed', {
          standardRef: String(std._id),
          parsedHeuristic: !!parsed,
          clausesTotal: clauses.length,
          clausesIndexed: toIndex.length,
        });
      } catch { }
    }

    const vectors = [];
    let modeHint = 'unknown';
    let seq = 0;
    for (let i = 0; i < toIndex.length; i += 1) {
      const c = toIndex[i];
      const quoteId = crypto
        .createHash('sha256')
        .update(String(std._id))
        .update(String(c.clauseId))
        .update(String(c.text).slice(0, 2000))
        .digest('hex');
      const entities = extractEntities(c.text);
      const mode = extractModeHints(c.text);
      if (modeHint === 'unknown') modeHint = mode;
      else if (modeHint !== mode && mode !== 'unknown') modeHint = 'both';

      const pageOrLoc = String(c.pageOrLoc || `chunk:${i + 1}`);
      const embeddingText = embeddingContext.buildEmbeddingText({
        kind: 'standard_clause',
        fields: {
          standardId,
          edition,
          clauseId: c.clauseId,
          title: c.title || '',
          pageOrLoc,
        },
        text: c.text,
      });
      const emb = await createEmbeddingVector(openai, embeddingText, embeddingModel);
      const tokens = encoder.encode(String(c.text || '')).length;
      const doc = await StandardClause.create({
        tenantId,
        standardRef: std._id,
        standardId,
        edition,
        clauseId: c.clauseId,
        title: c.title || '',
        pageOrLoc,
        quoteId,
        text: String(c.text || '').trim(),
        seq: ++seq,
        extractedEntities: entities,
        tokens,
        embedding: pineconeEnabled ? [] : emb,
      });

      if (pineconeEnabled && Array.isArray(emb) && emb.length) {
        vectors.push({
          id: `std:${String(doc._id)}`,
          values: emb,
          metadata: {
            kind: 'standard_clause',
            tenantId: String(tenantId),
            standardRef: String(std._id),
            standardId: String(standardId),
            edition: String(edition || ''),
            clauseId: String(c.clauseId),
            modeHint: extractModeHints(c.text),
            quoteId,
            seq: Number(doc.seq || 0),
            pageOrLoc,
          }
        });
      }
    }

    if (pineconeEnabled && vectors.length) {
      await pinecone.upsertVectors({ namespace, vectors });
    }

    await Standard.updateOne(
      { _id: std._id },
      {
        $set: {
          status: 'ready',
          error: '',
          modeHint,
          meta: { ...(std.meta || {}), embeddingFormatVersion: embeddingContext.getEmbeddingFormatVersion() },
          sourceFiles,
          aliases: Array.from(new Set([
            standardId,
            name,
            String(standardId).replace(/\s+/g, ''),
            String(standardId).toLowerCase(),
            String(name).toLowerCase(),
            edition ? `${standardId}:${edition}` : null,
          ].filter(Boolean)))
        }
      }
    );

    if (debugEnabled) {
      try {
        logger.info('standards.ingest.done', {
          standardRef: String(std._id),
          clauses: toIndex.length,
          pineconeEnabled,
        });
      } catch { }
    }
    return { standard: await Standard.findById(std._id).lean(), clauses: toIndex.length };
  } catch (e) {
    await Standard.updateOne({ _id: std._id }, { $set: { status: 'error', error: e?.message || 'ingestion failed' } });
    try { logger.error('standards.ingest.error', { standardRef: String(std._id), error: e?.message || 'ingestion failed' }); } catch { }
    throw e;
  }
}

async function deleteStandard({ tenantId, standardRef }) {
  const std = await Standard.findOne({ _id: standardRef, tenantId });
  if (!std) return;
  await StandardClause.deleteMany({ tenantId, standardRef: std._id });

  if (pinecone.isPineconeEnabled()) {
    const namespace = pinecone.resolveNamespace({ tenantId, projectId: 'standard-library' });
    await pinecone.deleteByFilter({
      namespace,
      filter: { tenantId: String(tenantId), kind: 'standard_clause', standardRef: String(std._id) },
      bestEffort: true,
    });
  }

  // Remove from any standard sets (best-effort)
  await StandardSet.updateMany({ tenantId }, { $pull: { standardRefs: std._id } }).catch(() => {});
  await Standard.deleteOne({ _id: std._id });
}

module.exports = {
  ingestStandardFiles,
  deleteStandard,
};
