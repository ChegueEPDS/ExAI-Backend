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
    description: 'Main chat completions model for conversations.',
  },
  {
    key: 'NOTIFICATIONS_SSE_HEARTBEAT_MS',
    group: 'SSE',
    type: 'number',
    defaultValue: 10000,
    description: 'Heartbeat interval (ms) for notifications SSE stream.',
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

  // Misc tuning knobs
  { key: 'CERT_FILE_CONCURRENCY', group: 'Misc', type: 'number', defaultValue: 4, description: 'Concurrent certificate-file processing.' },
  { key: 'QA_CHUNK_TOKENS', group: 'Misc', type: 'number', defaultValue: 900, description: 'Chunk tokens for upload/ask map stage.' },
  { key: 'UPLOAD_ASK_INPUT_CAP', group: 'Misc', type: 'number', defaultValue: 2000, description: 'Input cap for upload ask step.' },

  // Trainings / ROT (QR + reports)
  {
    key: 'QR_STAMP_SIZE',
    group: 'Training reports',
    type: 'number',
    defaultValue: 60,
    description: 'QR size in the final PDFs (PDF points).',
  },
  {
    key: 'QR_STAMP_MARGIN_X',
    group: 'Training reports',
    type: 'number',
    defaultValue: 50,
    description: 'QR horizontal margin from the left edge (PDF points).',
  },
  {
    key: 'QR_STAMP_MARGIN_Y',
    group: 'Training reports',
    type: 'number',
    defaultValue: 100,
    description: 'QR vertical margin from the bottom edge (PDF points).',
  },
  {
    key: 'QR_STAMP_NOTE_FONT_SIZE',
    group: 'Training reports',
    type: 'number',
    defaultValue: 8,
    description: 'Font size for the QR label + note under the QR (PDF points).',
  },

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
