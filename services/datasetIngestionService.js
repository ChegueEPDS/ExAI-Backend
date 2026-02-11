const crypto = require('crypto');
const xlsx = require('xlsx');
const { get_encoding } = require('tiktoken');
const OpenAI = require('openai');

const DatasetFile = require('../models/datasetFile');
const DatasetRowChunk = require('../models/datasetRowChunk');
const DatasetTableCell = require('../models/datasetTableCell');
const DatasetDocChunk = require('../models/datasetDocChunk');
const DatasetImageChunk = require('../models/datasetImageChunk');
const DatasetTableSchema = require('../models/datasetTableSchema');
const { inferTableSchemaWithLLM } = require('./tableSchemaService');
const { computeAndStoreDefaultDerivedMetrics } = require('./tableToolService');
const { extractPdfImageTexts } = require('./pdfVisionService');
const pinecone = require('./pineconeService');
const systemSettings = require('./systemSettingsStore');
const embeddingContext = require('./embeddingContext');
const logger = require('../config/logger');

const encoder = get_encoding('o200k_base');

function parseNumberLoose(input) {
  const s0 = String(input ?? '').trim();
  if (!s0) return null;
  const s = s0
    .replace(/\s/g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.+\-eE]/g, '');
  if (!s || s === '.' || s === '-' || s === '+') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

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

function buildRowText({ filename, sheet, rowIndex, headers, row }) {
  const pairs = [];
  const maxCols = Math.min(headers.length, row.length, 64);
  for (let c = 0; c < maxCols; c += 1) {
    const h = String(headers[c] ?? '').trim() || `col_${c}`;
    const v = String(row[c] ?? '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    pairs.push(`${h}=${v}`);
  }
  const body = pairs.join(' | ');
  return `FILE=${filename}\nSHEET=${sheet}\nROW_INDEX=${rowIndex}\n${body}`.trim();
}

async function extractDocumentToText({ baseUrl, fileBuffer, filename, contentType }) {
  const lower = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();

  // PDF -> reuse existing /api/pdfcert OCR/text pipeline
  if (ct === 'application/pdf' || lower.endsWith('.pdf')) {
    const FormData = require('form-data');
    const axios = require('axios');
    const axiosClient = axios.create({ timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: contentType || 'application/pdf' });
    form.append('certType', 'ATEX');
    const resp = await axiosClient.post(`${baseUrl}/api/pdfcert`, form, { headers: form.getHeaders() });
    return {
      text: String(resp.data?.recognizedText || ''),
      pagesText: Array.isArray(resp.data?.pagesText) ? resp.data.pagesText : [],
    };
  }

  // Images -> reuse existing vision pipeline endpoints
  if (ct.startsWith('image/')) {
    const FormData = require('form-data');
    const axios = require('axios');
    const axiosClient = axios.create({ timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const form = new FormData();
    form.append('image', fileBuffer, { filename, contentType: contentType || 'application/octet-stream' });
    const upload = await axiosClient.post(`${baseUrl}/api/vision/upload`, form, { headers: form.getHeaders() });
    const imageUrl = upload.data?.image_url;
    if (!imageUrl) return '';
    const analyze = await axiosClient.post(
      `${baseUrl}/api/vision/analyze`,
      { image_urls: [imageUrl], user_input: 'Extract all readable text and labels. If tables appear, describe them row-wise.' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return String(analyze.data?.analysis || analyze.data?.text || '');
  }

  // Plaintext-ish
  if (ct.startsWith('text/') || lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.html')) {
    try { return Buffer.from(fileBuffer).toString('utf8'); } catch { return ''; }
  }

  // Best-effort UTF-8 decode fallback
  try { return Buffer.from(fileBuffer).toString('utf8'); } catch { return ''; }
}

async function ingestTabularFileBuffer({
  tenantId,
  projectId,
  datasetId,
  datasetVersion,
  userId,
  fileBuffer,
  filename,
  contentType,
  blobPath,
  embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small',
  trace = null,
}) {
  const lowerName = String(filename || '').toLowerCase();
  const isXls = lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx');
  const isCsv = lowerName.endsWith('.csv');
  if (!isXls && !isCsv) {
    throw new Error('Tabular ingestion requires a spreadsheet (.xls, .xlsx, .csv).');
  }

  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  const fileDoc = await DatasetFile.create({
    tenantId,
    projectId,
    datasetId,
    datasetVersion,
    filename,
    contentType: contentType || 'application/octet-stream',
    size: Buffer.byteLength(fileBuffer || Buffer.alloc(0)),
    sha256,
    storage: { provider: 'azure_blob', blobPath: blobPath || '' },
    approvalStatus: 'pending',
    indexingStatus: 'processing',
    meta: { uploadedBy: userId, embeddingFormatVersion: embeddingContext.getEmbeddingFormatVersion() },
  });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pineconeEnabled = pinecone.isPineconeEnabled();
  const namespace = pineconeEnabled ? pinecone.resolveNamespace({ tenantId, projectId }) : null;

  try {
    const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');
    if (debugEnabled) {
      try {
        logger.info('dataset.ingest.tabular.start', {
          requestId: trace?.requestId,
          tenantId: String(tenantId || ''),
          projectId: String(projectId || ''),
          datasetVersion: Number(datasetVersion),
          filename,
          contentType,
          bytes: Buffer.byteLength(fileBuffer || Buffer.alloc(0)),
          pineconeEnabled,
          namespace,
        });
      } catch { }
    }

    let wb;
    try {
      wb = xlsx.read(fileBuffer, { type: 'buffer', cellText: false, cellDates: true });
    } catch (e) {
      // SheetJS sometimes throws cryptic "Could not find workbook" for non-spreadsheets.
      throw new Error('Could not parse spreadsheet (invalid or unsupported workbook).');
    }
    const sheetNames = (wb.SheetNames || []).slice(0, 12);
    let totalRows = 0;
    let totalCells = 0;

    // Create or reset LLM schema doc (best-effort). Schema generation is optional and can fail without blocking ingestion.
    let schemaDoc = null;
    try {
      schemaDoc = await DatasetTableSchema.findOneAndUpdate(
        { tenantId, projectId, datasetVersion, datasetFileId: fileDoc._id },
        {
          $setOnInsert: {
            tenantId,
            projectId,
            datasetId,
            datasetVersion,
            datasetFileId: fileDoc._id,
            filename,
          },
          $set: { status: 'pending', error: '', schema: {}, meta: { ...(fileDoc.meta || {}), kind: 'tabular' } },
        },
        { upsert: true, new: true }
      );
    } catch { }

    // Build a small workbook preview for schema inference (first N rows/cols with cell coords).
    const previewMaxRows = Math.max(5, Math.min(Number(systemSettings.getNumber('TABLE_SCHEMA_PREVIEW_ROWS') || 60), 120));
    const previewMaxCols = Math.max(5, Math.min(Number(systemSettings.getNumber('TABLE_SCHEMA_PREVIEW_COLS') || 20), 50));
    const workbookPreview = { sheets: [] };
    for (const sheetName of sheetNames.slice(0, 8)) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const ref = ws['!ref'];
      if (!ref) continue;
      const range = xlsx.utils.decode_range(ref);
      const rows = [];
      for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + previewMaxRows - 1); r += 1) {
        const row = [];
        for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + previewMaxCols - 1); c += 1) {
          const addr = xlsx.utils.encode_cell({ r, c });
          const cell = ws[addr];
          const v = cell && (cell.w !== undefined ? cell.w : cell.v !== undefined ? cell.v : '');
          row.push({ cell: addr, v: v === undefined || v === null ? '' : String(v).slice(0, 120) });
        }
        rows.push({ row: r + 1, cells: row });
      }
      workbookPreview.sheets.push({ sheet: sheetName, rows });
    }

    let inferredSchema = null;
    try {
      const r = await inferTableSchemaWithLLM({ filename, workbookPreview, trace });
      if (r?.ok && r?.schema) inferredSchema = r.schema;
      else if (schemaDoc && r && r.skipped) {
        await DatasetTableSchema.updateOne(
          { _id: schemaDoc._id },
          { $set: { status: 'error', error: String(r.error || 'schema inference skipped') } }
        );
      }
    } catch (e) {
      if (schemaDoc) {
        try {
          await DatasetTableSchema.updateOne(
            { _id: schemaDoc._id },
            { $set: { status: 'error', error: e?.message || 'schema inference failed' } }
          );
        } catch { }
      }
    }

    for (const sheetName of sheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const ref = ws['!ref'];
      if (!ref) continue;
      const range = xlsx.utils.decode_range(ref);
      const rangeRow0 = Number(range?.s?.r || 0);
      const rangeCol0 = Number(range?.s?.c || 0);
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '' });
      if (!Array.isArray(rows) || rows.length < 2) continue;

      const headers = (Array.isArray(rows[0]) ? rows[0] : []).map((h, idx) => {
        const s = String(h ?? '').replace(/\s+/g, ' ').trim();
        return s || `col_${idx}`;
      });

      const maxRows = Math.min(rows.length, Number(systemSettings.getNumber('DATASET_MAX_ROWS') || 5000));
      const maxCols = Math.min(Math.max(headers.length, 1), Number(systemSettings.getNumber('DATASET_MAX_COLS') || 80));

      const vectorsToUpsert = [];
      for (let r = 1; r < maxRows; r += 1) {
        const row = Array.isArray(rows[r]) ? rows[r] : [];
        const rowIndex = rangeRow0 + r + 1; // 1-based Excel row number (best-effort)
        const text = buildRowText({ filename, sheet: sheetName, rowIndex, headers, row });
        const tokens = encoder.encode(text).length;
        const embeddingText = embeddingContext.buildEmbeddingText({
          kind: 'table_row',
          fields: { filename, sheet: sheetName, rowIndex: String(rowIndex) },
          text,
        });
        const embedding = await createEmbeddingVector(openai, embeddingText, embeddingModel);

        const rowDoc = await DatasetRowChunk.create({
          tenantId,
          projectId,
          datasetId,
          datasetVersion,
          datasetFileId: fileDoc._id,
          filename,
          sheet: sheetName,
          rowIndex,
          text,
          tokens,
          embedding: pineconeEnabled ? [] : embedding,
        });
        totalRows += 1;

        if (pineconeEnabled && Array.isArray(embedding) && embedding.length) {
          vectorsToUpsert.push({
            id: `row:${String(rowDoc._id)}`,
            values: embedding,
            metadata: {
              kind: 'table_row',
              tenantId: String(tenantId),
              projectId: String(projectId),
              datasetVersion: Number(datasetVersion),
              datasetFileId: String(fileDoc._id),
              filename,
              sheet: sheetName,
              rowIndex,
            }
          });
        }

        // Numeric cells are captured from the worksheet below (true coordinates).
      }

      if (pineconeEnabled && vectorsToUpsert.length) {
        await pinecone.upsertVectors({ namespace, vectors: vectorsToUpsert });
      }

      // Capture numeric cells with real addresses (A1) from worksheet cells.
      const maxCells = Number(systemSettings.getNumber('DATASET_MAX_NUMERIC_CELLS') || 200000);
      try {
        const keys = Object.keys(ws).filter(k => k && k[0] !== '!' && /^[A-Z]+[0-9]+$/.test(k));
        for (const addr of keys) {
          if (totalCells >= maxCells) break;
          const cellObj = ws[addr];
          if (!cellObj) continue;
          const raw0 = (cellObj.w !== undefined ? cellObj.w : cellObj.v);
          const raw = String(raw0 ?? '').trim();
          const n = parseNumberLoose(raw);
          if (!Number.isFinite(n)) continue;
          const decoded = xlsx.utils.decode_cell(addr);
          const rowIndex = decoded.r + 1;
          const colIndex = decoded.c + 1;
          totalCells += 1;
          await DatasetTableCell.updateOne(
            { tenantId, projectId, datasetVersion, datasetFileId: fileDoc._id, sheet: sheetName, rowIndex, colIndex },
            {
              $set: {
                tenantId,
                projectId,
                datasetId,
                datasetVersion,
                datasetFileId: fileDoc._id,
                filename,
                sheet: sheetName,
                rowIndex,
                colIndex,
                cell: addr,
                colHeader: String(headers[colIndex - (rangeCol0 + 1)] ?? '').trim(),
                valueRaw: raw,
                valueNumber: n,
              }
            },
            { upsert: true }
          );
        }
      } catch { }
    }

    // Store schema (if inferred) and derive default metrics (best-effort).
    if (schemaDoc) {
      if (inferredSchema) {
        try {
          await DatasetTableSchema.updateOne(
            { _id: schemaDoc._id },
            { $set: { status: 'ready', error: '', schema: inferredSchema } }
          );
        } catch { }
        try {
          await computeAndStoreDefaultDerivedMetrics({
            tenantId,
            projectId,
            datasetId,
            datasetVersion,
            datasetFileId: fileDoc._id,
            filename,
            schema: inferredSchema,
            trace,
          });
        } catch (e) {
          if (debugEnabled) {
            try { logger.warn('table.metrics.error', { requestId: trace?.requestId, filename, error: e?.message || 'failed' }); } catch { }
          }
        }
      } else {
        try {
          await DatasetTableSchema.updateOne(
            { _id: schemaDoc._id },
            { $set: { status: 'error', error: 'schema not available' } }
          );
        } catch { }
      }
    }

    await DatasetFile.updateOne(
      { _id: fileDoc._id },
      { $set: { indexingStatus: 'done', indexingError: '', meta: { ...fileDoc.meta, kind: 'tabular', totalRows, totalNumericCells: totalCells } } }
    );
    if (systemSettings.getBoolean('DEBUG_GOVERNED')) {
      try {
        logger.info('dataset.ingest.tabular.done', {
          requestId: trace?.requestId,
          filename,
          datasetVersion: Number(datasetVersion),
          totalRows,
          totalNumericCells: totalCells,
          pineconeEnabled,
        });
      } catch { }
    }
    return { datasetFileId: fileDoc._id, sha256, totalRows, totalNumericCells: totalCells };
  } catch (e) {
    await DatasetFile.updateOne(
      { _id: fileDoc._id },
      { $set: { indexingStatus: 'error', indexingError: e?.message || 'ingestion failed' } }
    );
    try { logger.error('dataset.ingest.tabular.error', { requestId: trace?.requestId, filename, error: e?.message || 'ingestion failed' }); } catch { }
    throw e;
  }
}

async function ingestDocumentFileBuffer({
  tenantId,
  projectId,
  datasetId,
  datasetVersion,
  userId,
  fileBuffer,
  filename,
  contentType,
  blobPath,
  embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small',
  trace = null,
}) {
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const fileDoc = await DatasetFile.create({
    tenantId,
    projectId,
    datasetId,
    datasetVersion,
    filename,
    contentType: contentType || 'application/octet-stream',
    size: Buffer.byteLength(fileBuffer || Buffer.alloc(0)),
    sha256,
    storage: { provider: 'azure_blob', blobPath: blobPath || '' },
    approvalStatus: 'pending',
    indexingStatus: 'processing',
    meta: { uploadedBy: userId, kind: 'document', embeddingFormatVersion: embeddingContext.getEmbeddingFormatVersion() },
  });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pineconeEnabled = pinecone.isPineconeEnabled();
  const namespace = pineconeEnabled ? pinecone.resolveNamespace({ tenantId, projectId }) : null;
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

  try {
    const debugEnabled = systemSettings.getBoolean('DEBUG_GOVERNED');
    if (debugEnabled) {
      try {
        logger.info('dataset.ingest.document.start', {
          requestId: trace?.requestId,
          tenantId: String(tenantId || ''),
          projectId: String(projectId || ''),
          datasetVersion: Number(datasetVersion),
          filename,
          contentType,
          bytes: Buffer.byteLength(fileBuffer || Buffer.alloc(0)),
          pineconeEnabled,
          namespace,
        });
      } catch { }
    }

    const extracted = await extractDocumentToText({ baseUrl, fileBuffer, filename, contentType });
    const safeText = (typeof extracted === 'object' && extracted !== null)
      ? String(extracted.text || '').replace(/\u0000/g, '').trim()
      : String(extracted || '').replace(/\u0000/g, '').trim();
    const docChunkTokens = Number(systemSettings.getNumber('DOCUMENT_CHUNK_TOKENS') || 450);
    const docChunkOverlap = Number(systemSettings.getNumber('DOCUMENT_CHUNK_OVERLAP') || 80);
    const pagesText = (typeof extracted === 'object' && extracted !== null && Array.isArray(extracted.pagesText))
      ? extracted.pagesText.map(t => String(t || '').replace(/\u0000/g, '').trim()).filter(Boolean)
      : [];
    const isPdf = String(contentType || '').toLowerCase() === 'application/pdf' || String(filename || '').toLowerCase().endsWith('.pdf');
    const imagePages = (isPdf && typeof extracted === 'object' && extracted !== null && Array.isArray(extracted.imagePages))
      ? extracted.imagePages
      : [];

    const locatedChunks = [];
    if (pagesText.length) {
      for (let p = 0; p < pagesText.length; p += 1) {
        const pageNo = p + 1;
        const pageChunks = chunkWithOverlap(pagesText[p], { chunkTokens: docChunkTokens, overlapTokens: docChunkOverlap })
          .filter(x => String(x || '').trim());
        for (const t of pageChunks) {
          locatedChunks.push({ text: t, pageOrLoc: `page:${pageNo}`, pageNumber: pageNo });
        }
      }
    } else {
      const chunks = chunkWithOverlap(safeText, { chunkTokens: docChunkTokens, overlapTokens: docChunkOverlap }).filter(x => String(x || '').trim());
      for (let i = 0; i < chunks.length; i += 1) {
        locatedChunks.push({ text: chunks[i], pageOrLoc: `chunk:${i + 1}`, pageNumber: null });
      }
    }

    const limited = locatedChunks.slice(0, Number(systemSettings.getNumber('DATASET_MAX_DOC_CHUNKS') || 120));

    const vectorsToUpsert = [];
    for (let i = 0; i < limited.length; i += 1) {
      const chunkText = String(limited[i]?.text || '');
      const pageOrLoc = String(limited[i]?.pageOrLoc || `chunk:${i + 1}`);
      const pageNumber = Number.isInteger(limited[i]?.pageNumber) ? Number(limited[i].pageNumber) : null;
      const tokens = encoder.encode(chunkText).length;
      const embeddingText = embeddingContext.buildEmbeddingText({
        kind: 'doc_chunk',
        fields: { filename, pageOrLoc },
        text: chunkText,
      });
      const embedding = await createEmbeddingVector(openai, embeddingText, embeddingModel);
      const docChunk = await DatasetDocChunk.create({
        tenantId,
        projectId,
        datasetId,
        datasetVersion,
        datasetFileId: fileDoc._id,
        filename,
        chunkIndex: i,
        text: chunkText,
        tokens,
        embedding: pineconeEnabled ? [] : embedding,
        meta: { pageOrLoc, ...(pageNumber ? { pageNumber } : {}) },
      });

      if (pineconeEnabled && Array.isArray(embedding) && embedding.length) {
        vectorsToUpsert.push({
          id: `doc:${String(docChunk._id)}`,
          values: embedding,
          metadata: {
            kind: 'doc_chunk',
            tenantId: String(tenantId),
            projectId: String(projectId),
            datasetVersion: Number(datasetVersion),
            datasetFileId: String(fileDoc._id),
            filename,
            chunkIndex: i,
            pageOrLoc,
            ...(pageNumber ? { pageNumber } : {}),
          }
        });
      }
    }

    if (pineconeEnabled && vectorsToUpsert.length) {
      await pinecone.upsertVectors({ namespace, vectors: vectorsToUpsert });
    }

    // Optional: image/figure extraction from PDFs via Vision (stored as separate chunks).
    let imageChunkCount = 0;
    if (isPdf) {
      const maxPages = Math.max(0, Math.min(Number(systemSettings.getNumber('PDF_VISION_MAX_PAGES') || 2), 10));
      let pages = imagePages;
      if (!pages.length && maxPages > 0) {
        try {
          const r = await extractPdfImageTexts({ pdfBuffer: fileBuffer, maxPages, trace });
          pages = Array.isArray(r?.pages) ? r.pages : [];
        } catch { }
      }
      if (Array.isArray(pages) && pages.length) {
        const imgVectors = [];
        for (let i = 0; i < pages.length; i += 1) {
          const pageNo = Number(pages[i]?.pageNo || i + 1);
          const text = String(pages[i]?.text || '').replace(/\u0000/g, '').trim();
          if (!text) continue;
          const tokens = encoder.encode(text).length;
          const embeddingText = embeddingContext.buildEmbeddingText({
            kind: 'image_chunk',
            fields: { filename, pageOrLoc },
            text,
          });
          const embedding = await createEmbeddingVector(openai, embeddingText, embeddingModel);
          const pageOrLoc = `page:${pageNo} image:1`;
          const imgChunk = await DatasetImageChunk.create({
            tenantId,
            projectId,
            datasetId,
            datasetVersion,
            datasetFileId: fileDoc._id,
            filename,
            pageNumber: Number.isInteger(pageNo) ? pageNo : null,
            imageIndex: i,
            text,
            tokens,
            embedding: pineconeEnabled ? [] : embedding,
            meta: { pageOrLoc, source: 'vision' },
          });
          imageChunkCount += 1;
          if (pineconeEnabled && Array.isArray(embedding) && embedding.length) {
            imgVectors.push({
              id: `img:${String(imgChunk._id)}`,
              values: embedding,
              metadata: {
                kind: 'image_chunk',
                tenantId: String(tenantId),
                projectId: String(projectId),
                datasetVersion: Number(datasetVersion),
                datasetFileId: String(fileDoc._id),
                filename,
                pageOrLoc,
                ...(Number.isInteger(pageNo) ? { pageNumber: pageNo } : {}),
              }
            });
          }
        }
        if (pineconeEnabled && imgVectors.length) {
          await pinecone.upsertVectors({ namespace, vectors: imgVectors });
        }
      }
    }

    await DatasetFile.updateOne(
      { _id: fileDoc._id },
      { $set: { indexingStatus: 'done', indexingError: '', meta: { ...fileDoc.meta, docChunks: limited.length, imageChunks: imageChunkCount } } }
    );
    if (debugEnabled) {
      try {
        logger.info('dataset.ingest.document.done', {
          requestId: trace?.requestId,
          filename,
          datasetVersion: Number(datasetVersion),
          chunks: limited.length,
          imageChunks: imageChunkCount,
          pineconeEnabled,
        });
      } catch { }
    }
    return { datasetFileId: fileDoc._id, sha256, docChunks: limited.length };
  } catch (e) {
    await DatasetFile.updateOne(
      { _id: fileDoc._id },
      { $set: { indexingStatus: 'error', indexingError: e?.message || 'ingestion failed' } }
    );
    try { logger.error('dataset.ingest.document.error', { requestId: trace?.requestId, filename, error: e?.message || 'ingestion failed' }); } catch { }
    throw e;
  }
}

async function deleteDatasetFileArtifacts({ tenantId, projectId, datasetFileId, datasetVersion = null }) {
  await DatasetRowChunk.deleteMany({ tenantId, projectId, datasetFileId });
  await DatasetTableCell.deleteMany({ tenantId, projectId, datasetFileId });
  await DatasetDocChunk.deleteMany({ tenantId, projectId, datasetFileId });
  await DatasetImageChunk.deleteMany({ tenantId, projectId, datasetFileId });

  if (pinecone.isPineconeEnabled()) {
    const namespace = pinecone.resolveNamespace({ tenantId, projectId });
    const filter = {
      tenantId: String(tenantId),
      projectId: String(projectId),
      datasetFileId: String(datasetFileId),
    };
    if (datasetVersion !== null && datasetVersion !== undefined) {
      filter.datasetVersion = Number(datasetVersion);
    }
    await pinecone.deleteByFilter({ namespace, filter, bestEffort: true });
  }
}

module.exports = {
  ingestTabularFileBuffer,
  ingestDocumentFileBuffer,
  deleteDatasetFileArtifacts,
  parseNumberLoose,
};
