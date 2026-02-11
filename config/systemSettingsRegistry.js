/**
 * System (global) settings that used to be controlled by env vars.
 * - NOT tenant-specific (applies to all tenants).
 * - Only SuperAdmin can update via admin UI.
 * - Defaults are defined here and can be restored via "reset to default".
 */

const SETTINGS = [
  // Chat models
  {
    key: 'FILE_CHAT_COMPLETIONS_MODEL',
    group: 'Chat models',
    type: 'string',
    defaultValue: 'gpt-5-mini',
    description: 'Main Chat Completions model (governed + conversations).',
  },
  {
    key: 'GOVERNED_REQUIRE_NUMERIC_EVIDENCE',
    group: 'Chat models',
    type: 'boolean',
    defaultValue: true,
    description: 'Require strict numericEvidence for numeric claims (governed chat).',
  },
  {
    key: 'SUMMARY_COMPLETIONS_MODEL',
    group: 'Chat models',
    type: 'string',
    defaultValue: 'gpt-5-mini',
    description: 'Rolling summary + upload/ask map-reduce model.',
  },
  {
    key: 'SUMMARY_COMPLETIONS_FALLBACK',
    group: 'Chat models',
    type: 'string',
    defaultValue: 'gpt-5-mini',
    description: 'Fallback model for upload/ask map-reduce.',
  },

  // Governed RAG (datasets + standards)
  {
    key: 'DEBUG_GOVERNED',
    group: 'Governed RAG',
    type: 'boolean',
    defaultValue: false,
    description: 'Verbose end-to-end logging for governed flows.',
  },

  // Dataset ingestion limits
  { key: 'DATASET_MAX_ROWS', group: 'Datasets', type: 'number', defaultValue: 20000, description: 'Max spreadsheet rows indexed.' },
  { key: 'DATASET_MAX_COLS', group: 'Datasets', type: 'number', defaultValue: 128, description: 'Max spreadsheet columns indexed.' },
  { key: 'DATASET_MAX_NUMERIC_CELLS', group: 'Datasets', type: 'number', defaultValue: 200000, description: 'Max numeric cells stored for traceability.' },
  { key: 'DATASET_MAX_DOC_CHUNKS', group: 'Datasets', type: 'number', defaultValue: 120, description: 'Max document chunks per dataset file.' },

  // Document chunking
  { key: 'DOCUMENT_CHUNK_TOKENS', group: 'Chunking', type: 'number', defaultValue: 450, description: 'Document chunk size (approx tokens).' },
  { key: 'DOCUMENT_CHUNK_OVERLAP', group: 'Chunking', type: 'number', defaultValue: 80, description: 'Document chunk overlap (approx tokens).' },

  // Table schema (LLM-assisted)
  { key: 'TABLE_SCHEMA_LLM_ENABLED', group: 'Table schema', type: 'boolean', defaultValue: true, description: 'Enable LLM-based spreadsheet schema inference.' },
  { key: 'TABLE_SCHEMA_MODEL', group: 'Table schema', type: 'string', defaultValue: 'gpt-5-mini', description: 'Model for table schema inference.' },
  { key: 'TABLE_SCHEMA_PREVIEW_ROWS', group: 'Table schema', type: 'number', defaultValue: 60, description: 'Spreadsheet preview rows for schema inference.' },
  { key: 'TABLE_SCHEMA_PREVIEW_COLS', group: 'Table schema', type: 'number', defaultValue: 20, description: 'Spreadsheet preview cols for schema inference.' },

  { key: 'TABLE_STEADY_N', group: 'Table tools', type: 'number', defaultValue: 3, description: 'Steady-state heuristic window size (last N points).' },

  // Measurement evaluator
  { key: 'MEAS_EVAL_ENABLED', group: 'Measurement evaluator', type: 'boolean', defaultValue: true, description: 'Enable measurement evaluator tool.' },
  { key: 'MEAS_EVAL_MAX_FILES', group: 'Measurement evaluator', type: 'number', defaultValue: 3, description: 'Max XLSX files evaluated per question.' },
  { key: 'MEAS_EVAL_MAX_SHEETS', group: 'Measurement evaluator', type: 'number', defaultValue: 12, description: 'Max sheets evaluated per XLSX file.' },
  { key: 'MEAS_EVAL_MAX_TABLES', group: 'Measurement evaluator', type: 'number', defaultValue: 8, description: 'Max “Table N” blocks evaluated per sheet.' },
  { key: 'MEAS_EXT_POINTS', group: 'Measurement evaluator', type: 'string', defaultValue: 'T10,T11,T4', description: 'Measurement points counted as “external surface” (CSV).' },
  { key: 'MEAS_LIMIT_GAS_T4_C', group: 'Measurement evaluator', type: 'string', defaultValue: '', description: 'Gas temperature class limit hint (e.g. T4=135°C). Optional.' },
  { key: 'MEAS_LIMIT_DUST_SURFACE_C', group: 'Measurement evaluator', type: 'string', defaultValue: '', description: 'Dust surface temperature limit hint (e.g. T70°C). Optional.' },
  { key: 'MEAS_POINT_MAX', group: 'Measurement evaluator', type: 'number', defaultValue: 25, description: 'Maximum measurement-point token number.' },
  { key: 'MEAS_COMPARE_DELTA_C', group: 'Measurement evaluator', type: 'number', defaultValue: 3, description: 'Significant delta threshold (°C) for Table 1..4 comparisons.' },
  { key: 'MEAS_STEADY_LAST_N', group: 'Measurement evaluator', type: 'number', defaultValue: 3, description: 'How many last time columns treated as steady-state window.' },
  { key: 'MEAS_DIFF_NOISE_C', group: 'Measurement evaluator', type: 'number', defaultValue: 2, description: 'Engineer-style difference thresholds (°C): noise.' },
  { key: 'MEAS_DIFF_NOTE_C', group: 'Measurement evaluator', type: 'number', defaultValue: 3, description: 'Engineer-style difference thresholds (°C): note.' },
  { key: 'MEAS_DIFF_CRITICAL_C', group: 'Measurement evaluator', type: 'number', defaultValue: 5, description: 'Engineer-style difference thresholds (°C): critical.' },

  // XLSX planner
  { key: 'XLSX_PLANNER_ENABLED', group: 'XLSX planner', type: 'boolean', defaultValue: true, description: 'Enable XLSX planner (LLM chooses deterministic tool).' },
  { key: 'XLSX_PLANNER_MODEL', group: 'XLSX planner', type: 'string', defaultValue: 'gpt-5-mini', description: 'Model for XLSX planner.' },
  { key: 'XLSX_PLANNER_PREVIEW_MAX_FILES', group: 'XLSX planner', type: 'number', defaultValue: 3, description: 'Preview max files.' },
  { key: 'XLSX_PLANNER_PREVIEW_MAX_SHEETS', group: 'XLSX planner', type: 'number', defaultValue: 12, description: 'Preview max sheets.' },
  { key: 'XLSX_PLANNER_PREVIEW_MAX_ROWS', group: 'XLSX planner', type: 'number', defaultValue: 8000, description: 'Preview max rows.' },
  { key: 'XLSX_PLANNER_PREVIEW_MAX_LABELS', group: 'XLSX planner', type: 'number', defaultValue: 16, description: 'Preview max labels per sheet.' },
  { key: 'XLSX_PLANNER_PREVIEW_MAX_CHARS', group: 'XLSX planner', type: 'number', defaultValue: 35000, description: 'Preview max characters.' },

  // PDF vision
  { key: 'PDF_VISION_ENABLED', group: 'PDF vision', type: 'boolean', defaultValue: false, description: 'Enable PDF page rendering + vision extraction.' },
  { key: 'PDF_VISION_MAX_PAGES', group: 'PDF vision', type: 'number', defaultValue: 2, description: 'Max PDF pages to analyze with vision.' },
  { key: 'PDF_VISION_DENSITY', group: 'PDF vision', type: 'number', defaultValue: 150, description: 'Render density for vision (DPI).' },
  { key: 'PDF_VISION_WIDTH', group: 'PDF vision', type: 'number', defaultValue: 1400, description: 'Render width (px).' },
  { key: 'VISION_MODEL', group: 'PDF vision', type: 'string', defaultValue: 'gpt-4o-mini', description: 'Vision model for image understanding.' },

  // Standard chunking
  { key: 'STANDARD_CHUNK_TOKENS', group: 'Standards', type: 'number', defaultValue: 450, description: 'Standard chunk size (approx tokens).' },
  { key: 'STANDARD_CHUNK_OVERLAP', group: 'Standards', type: 'number', defaultValue: 80, description: 'Standard chunk overlap (approx tokens).' },
  { key: 'STANDARD_CLAUSE_MAX_TOKENS', group: 'Standards', type: 'number', defaultValue: 500, description: 'Max tokens per clause chunk before splitting.' },
  { key: 'STANDARD_MAX_CLAUSES', group: 'Standards', type: 'number', defaultValue: 1200, description: 'Max number of stored clauses per standard.' },

  // Standard set router
  { key: 'STANDARD_ROUTER_LLM', group: 'Standards', type: 'boolean', defaultValue: true, description: 'Enable LLM routing for standard-set selection.' },
  { key: 'STANDARD_ROUTER_MODEL', group: 'Standards', type: 'string', defaultValue: 'gpt-5-mini', description: 'Model for standard-set routing.' },
  { key: 'STANDARD_SET_FUZZY_ENABLED', group: 'Standards', type: 'boolean', defaultValue: true, description: 'Enable fuzzy set matching.' },
  { key: 'STANDARD_SET_FUZZY_THRESHOLD', group: 'Standards', type: 'number', defaultValue: 0.86, description: 'Similarity threshold for fuzzy set matching.' },

  // Retrieval sizes
  { key: 'GOVERNED_RAG_TOPK', group: 'Retrieval', type: 'number', defaultValue: 14, description: 'Final topK spreadsheet row chunks.' },
  { key: 'GOVERNED_RAG_DOC_TOPK', group: 'Retrieval', type: 'number', defaultValue: 10, description: 'Final topK document chunks.' },
  { key: 'GOVERNED_RAG_IMG_TOPK', group: 'Retrieval', type: 'number', defaultValue: 6, description: 'Final topK image/figure chunks (vision).' },
  { key: 'GOVERNED_RAG_STD_TOPK', group: 'Retrieval', type: 'number', defaultValue: 12, description: 'Final topK standard clauses.' },
  { key: 'GOVERNED_RAG_TABLE_CANDIDATES', group: 'Retrieval', type: 'number', defaultValue: 50, description: 'Candidate pool size (tables) from vector search.' },
  { key: 'GOVERNED_RAG_DOC_CANDIDATES', group: 'Retrieval', type: 'number', defaultValue: 40, description: 'Candidate pool size (docs) from vector search.' },
  { key: 'GOVERNED_RAG_IMG_CANDIDATES', group: 'Retrieval', type: 'number', defaultValue: 20, description: 'Candidate pool size (images) from vector search.' },
  { key: 'GOVERNED_RAG_STD_CANDIDATES', group: 'Retrieval', type: 'number', defaultValue: 60, description: 'Candidate pool size (standards) from vector search.' },
  { key: 'GOVERNED_RAG_TABLE_PER_FILE', group: 'Retrieval', type: 'number', defaultValue: 3, description: 'Cap selected table chunks per filename.' },
  { key: 'GOVERNED_RAG_DOC_PER_FILE', group: 'Retrieval', type: 'number', defaultValue: 3, description: 'Cap selected doc chunks per filename.' },
  { key: 'GOVERNED_RAG_IMG_PER_FILE', group: 'Retrieval', type: 'number', defaultValue: 1, description: 'Cap selected image chunks per filename.' },
  { key: 'GOVERNED_RAG_STD_PER_STANDARD', group: 'Retrieval', type: 'number', defaultValue: 6, description: 'Cap selected standard clauses per standardRef.' },

  { key: 'HYBRID_MAX_CANDIDATES', group: 'Retrieval', type: 'number', defaultValue: 80, description: 'Max candidates fetched per kind for hybrid/rerank stage.' },
  { key: 'HYBRID_ALPHA', group: 'Retrieval', type: 'number', defaultValue: 0.25, description: 'Weight of keyword score added to vector score.' },

  // Reranking
  { key: 'RERANK_ENABLED', group: 'Reranking', type: 'boolean', defaultValue: true, description: 'Enable LLM reranking of candidates.' },
  { key: 'RERANK_MODEL', group: 'Reranking', type: 'string', defaultValue: 'gpt-5-mini', description: 'Model for reranking.' },
  { key: 'RERANK_MODEL_STANDARD_CLAUSE', group: 'Reranking', type: 'string', defaultValue: 'gpt-4o-mini', description: 'Model override for reranking standard clauses.' },
  { key: 'RERANK_MAX_ITEMS', group: 'Reranking', type: 'number', defaultValue: 40, description: 'Max items per kind passed to reranker.' },
  { key: 'RERANK_MAX_ITEMS_STANDARD_CLAUSE', group: 'Reranking', type: 'number', defaultValue: 60, description: 'Max standard clauses passed to reranker.' },
  { key: 'GOVERNED_RAG_MAX_CANDIDATES', group: 'Reranking', type: 'number', defaultValue: 3500, description: 'Max Mongo candidates scanned when Pinecone disabled (tables).' },
  { key: 'GOVERNED_RAG_MAX_DOC_CANDIDATES', group: 'Reranking', type: 'number', defaultValue: 2500, description: 'Max Mongo candidates scanned when Pinecone disabled (docs).' },

  // Standard Explorer
  { key: 'STANDARD_EXPLORER_MODEL', group: 'Standard Explorer', type: 'string', defaultValue: 'gpt-4o-mini', description: 'Model for Standard Explorer mode.' },
  { key: 'STANDARD_EXPLORER_MAX_OUTPUT_TOKENS', group: 'Standard Explorer', type: 'number', defaultValue: 2500, description: 'Output token budget in Standard Explorer mode.' },
  { key: 'STANDARD_EXPLORER_FALLBACK_MIN_MATCHES', group: 'Standard Explorer', type: 'number', defaultValue: 10, description: 'Min matches threshold before broader standard set fallback.' },
  { key: 'STANDARD_PDF_SAS_TTL_SECONDS', group: 'Standard Explorer', type: 'number', defaultValue: 600, description: 'Signed URL TTL for standard PDFs (seconds).' },

  // Pinecone
  { key: 'DEBUG_PINECONE', group: 'Pinecone', type: 'boolean', defaultValue: false, description: 'Verbose Pinecone request logging.' },
  { key: 'PINECONE_ENABLED', group: 'Pinecone', type: 'boolean', defaultValue: false, description: 'Enable/disable Pinecone (optional; key+index may still auto-enable).' },

  // Misc tuning knobs
  { key: 'CERT_FILE_CONCURRENCY', group: 'Misc', type: 'number', defaultValue: 4, description: 'Concurrent certificate-file processing.' },
  { key: 'QA_CHUNK_TOKENS', group: 'Misc', type: 'number', defaultValue: 900, description: 'Chunk tokens for upload/ask map stage.' },
  { key: 'UPLOAD_ASK_INPUT_CAP', group: 'Misc', type: 'number', defaultValue: 2000, description: 'Input cap for upload ask step.' },

  // Contribution rewards (certificate upload incentives)
  {
    key: 'CONTRIBUTION_REWARD_AUTO_ENABLED',
    group: 'Contribution rewards',
    type: 'boolean',
    defaultValue: true,
    description: 'Enable/disable automatic reward issuing on certificate uploads/finalization.',
  },
  {
    key: 'CONTRIBUTION_REWARD_STEP',
    group: 'Contribution rewards',
    type: 'number',
    defaultValue: 20,
    description: 'Issue a reward at every N certificates (e.g. 20 -> 20/40/60...).',
  },

  // Dataplate extraction
  {
    key: 'DATAPLATE_EXTRACT_MAX_REPAIR_ITERS',
    group: 'Dataplate extraction',
    type: 'number',
    defaultValue: 3,
    description: 'Max iterative repair attempts for dataplate JSON extraction (strict validators + evidence gated).',
  },
  {
    key: 'DEBUG_DATAPLATE_EXTRACT',
    group: 'Dataplate extraction',
    type: 'boolean',
    defaultValue: false,
    description: 'Verbose logging for dataplate extract/validate/repair pipeline (server console).',
  },

  // Report export retention / links
  { key: 'REPORT_EXPORT_RETENTION_DAYS', group: 'Report export', type: 'number', defaultValue: 7, description: 'Retention in days.' },
  { key: 'REPORT_EXPORT_CLEANUP_INTERVAL_MS', group: 'Report export', type: 'number', defaultValue: 3600000, description: 'Cleanup interval (ms).' },
  { key: 'REPORT_EXPORT_DOWNLOAD_URL_TTL', group: 'Report export', type: 'number', defaultValue: 86400, description: 'Signed URL TTL for downloads (seconds).' },
  { key: 'REPORT_EXPORT_EMAIL_LINK_TTL', group: 'Report export', type: 'number', defaultValue: 86400, description: 'Email link TTL (seconds).' },

  // Equip docs import
  { key: 'EQUIP_DOCS_IMPORT_ERROR_XLS_TTL', group: 'Equip docs import', type: 'number', defaultValue: 86400, description: 'TTL for error XLS artifacts (seconds).' },
  { key: 'EQUIP_DOCS_IMPORT_ERROR_XLS_RETENTION_DAYS', group: 'Equip docs import', type: 'number', defaultValue: 7, description: 'Retention days for error XLS artifacts.' },
];

const REGISTRY_MAP = new Map(SETTINGS.map((s) => [s.key, s]));

function getDefinition(key) {
  return REGISTRY_MAP.get(key) || null;
}

function getAllDefinitions() {
  return SETTINGS.slice();
}

module.exports = {
  getDefinition,
  getAllDefinitions,
  SETTINGS,
};
