# Pinecone (governed sandbox)

This backend can use Pinecone for vector search in the governed dataset flow.

## Environment variables

- `PINECONE_ENABLED` (optional): `1|true` to force-enable Pinecone. If omitted, Pinecone is enabled when both `PINECONE_API_KEY` and `PINECONE_INDEX` are set.
- `PINECONE_API_KEY` (required when enabled)
- `PINECONE_INDEX` (required when enabled)
- `PINECONE_HOST` (optional): Pinecone index host (recommended for serverless).
- `PINECONE_NAMESPACE` (optional): fixed namespace to use.
- `PINECONE_NAMESPACE_TEMPLATE` (optional): template for namespace. Supported placeholders: `{tenantId}`, `{projectId}`.
  - Default namespace (if neither is set): `t:{tenantId}:p:{projectId}`
- `PINECONE_UPSERT_BATCH` (optional): upsert batch size (default `100`).

## Chunking / retrieval tuning (compliance-friendly defaults)

Document chunking (project uploads):
- `DOCUMENT_CHUNK_TOKENS` (default `450`)
- `DOCUMENT_CHUNK_OVERLAP` (default `80`)

Spreadsheet schema (LLM-assisted, optional):
- `TABLE_SCHEMA_LLM_ENABLED` (default `1`) – infer spreadsheet structure from a workbook preview (reduces per-project code changes)
- `TABLE_SCHEMA_MODEL` (default `gpt-5-mini`)
- `TABLE_SCHEMA_PREVIEW_ROWS` (default `60`)
- `TABLE_SCHEMA_PREVIEW_COLS` (default `20`)
- `TABLE_STEADY_N` (default `3`) – steady-state heuristic window for timeseries

Measurement evaluator (deterministic Excel analysis):
- `MEAS_EVAL_ENABLED` (default `1`) – runs a deterministic XLSX evaluation for risk/measurement questions and injects results into governed chat
- `MEAS_EVAL_MAX_FILES` (default `3`)
- `MEAS_EVAL_MAX_SHEETS` (default `12`)
- `MEAS_EVAL_MAX_TABLES` (default `8`)
- `MEAS_EXT_POINTS` (default `T10,T11,T4`) – points treated as “external surface”
- `MEAS_LIMIT_GAS_T4_C` (optional) – policy hint; prefer citing limits from standards via quotes
- `MEAS_LIMIT_DUST_SURFACE_C` (optional)

PDF figures/diagrams (optional, best-effort):
- `PDF_VISION_ENABLED` (default `0`) – render first pages and run vision to capture drawings/infographics
- `PDF_VISION_MAX_PAGES` (default `2`)
- `PDF_VISION_DENSITY` (default `150`)
- `PDF_VISION_WIDTH` (default `1400`)
- `VISION_MODEL` (default `gpt-4o-mini`)

Standard library chunking:
- `STANDARD_CHUNK_TOKENS` (default `450`) – used only when clause parsing fails (fallback token chunking)
- `STANDARD_CHUNK_OVERLAP` (default `80`)
- `STANDARD_CLAUSE_MAX_TOKENS` (default `500`) – long clauses are split into parts `clauseId#pN`
- `STANDARD_MAX_CLAUSES` (default `1200`)

Governed retrieval caps:
- `GOVERNED_RAG_TOPK` (default `14`) – final table rows
- `GOVERNED_RAG_DOC_TOPK` (default `10`) – final doc chunks
- `GOVERNED_RAG_IMG_TOPK` (default `6`) – final image/figure chunks (vision)
- `GOVERNED_RAG_STD_TOPK` (default `12`) – final standard clauses
- `GOVERNED_RAG_TABLE_CANDIDATES` (default `50`) – Pinecone candidate fetch before per-file cap
- `GOVERNED_RAG_DOC_CANDIDATES` (default `40`)
- `GOVERNED_RAG_IMG_CANDIDATES` (default `20`)
- `GOVERNED_RAG_STD_CANDIDATES` (default `60`)
- `GOVERNED_RAG_TABLE_PER_FILE` (default `3`)
- `GOVERNED_RAG_DOC_PER_FILE` (default `3`)
- `GOVERNED_RAG_IMG_PER_FILE` (default `1`)
- `GOVERNED_RAG_STD_PER_STANDARD` (default `6`)
- `HYBRID_MAX_CANDIDATES` (default `80`) – fetched per kind before hybrid/rerank
- `HYBRID_ALPHA` (default `0.25`) – keyword boost weight
- `RERANK_ENABLED` (default `1`) – LLM rerank after vector+keyword scoring
- `RERANK_MODEL` (default `gpt-5-mini`)
- `RERANK_MAX_ITEMS` (default `40`)

## Metadata / filtering

Vectors are upserted with minimal metadata so the backend can filter by:
- `tenantId`, `projectId`, `datasetVersion`
- `kind`: `table_row`, `doc_chunk`, or `image_chunk`
- `datasetFileId`, `filename`, and for tables also: `sheet`, `rowIndex`

Standard library clauses (tenant-wide) are upserted with:
- `kind`: `standard_clause`
- `tenantId`, `standardRef`, `standardId`, `edition`, `clauseId`, `modeHint`, `quoteId`
- Namespace defaults to `t:{tenantId}:p:standard-library` unless overridden by `PINECONE_NAMESPACE*`.

This allows one Pinecone index to serve many projects/tenants and still keep strict governance via metadata filters.

## Rollout

- Set the env vars above and restart the backend.
- New ingestions will upsert vectors to Pinecone.
- Governed chat retrieval will query Pinecone; if Pinecone is disabled/misconfigured it falls back to Mongo-stored embeddings.

## Standard library endpoints

- `POST /api/standards/upload` (multipart/form-data)
  - fields: `name`, `standardId`, optional `edition`, files: `files[]`
- `GET /api/standards`
- `GET /api/standards/:standardRef`
- `GET /api/standards/:standardRef/clauses?limit=50`
- `DELETE /api/standards/:standardRef`

Standard bundles:
- `POST /api/standard-sets` JSON: `{ key, name, modeHint?, standardRefs: string[], aliases?: string[] }`
- `GET /api/standard-sets`
- `DELETE /api/standard-sets/:setId`
