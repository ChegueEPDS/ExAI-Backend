/**
 * Tenant-scoped settings registry.
 * These settings are configurable by Admin/SuperAdmin per-tenant (stored in DB).
 */

const SETTINGS = [
  // Branding / public links
  {
    key: 'PUBLIC_BASE_URL',
    group: 'Branding',
    type: 'string',
    defaultValue: '',
    description:
      'Public base URL for links in emails/notifications (scheme + host). If empty, links may be derived from request headers or env fallbacks.',
  },

  // Tenant AI profile (no Assistants API dependency)
  {
    key: 'AI_MODEL',
    group: 'AI Profile',
    type: 'string',
    defaultValue: 'gpt-4o-mini',
    description: 'Default model for tenant AI (chat + extractors unless overridden).',
  },
  {
    key: 'AI_INSTRUCTIONS',
    group: 'AI Profile',
    type: 'string',
    defaultValue: '',
    description: 'Tenant AI instructions/persona used for chat and extractors.',
  },
  {
    key: 'KB_VECTOR_STORE_ID',
    group: 'Knowledge Base',
    type: 'string',
    defaultValue: null,
    description: 'Default OpenAI vector_store_id used for file_search.',
  },

  // Chat (Responses API) tuning knobs
  {
    key: 'CHAT_TEMPERATURE',
    group: 'Chat',
    type: 'number',
    defaultValue: 0,
    description: 'Responses API: sampling temperature (0..2).',
    constraints: { min: 0, max: 2 },
  },
  {
    key: 'CHAT_TOP_P',
    group: 'Chat',
    type: 'number',
    defaultValue: 1,
    description: 'Responses API: nucleus sampling top_p (0..1).',
    constraints: { min: 0, max: 1 },
  },
  {
    key: 'CHAT_MAX_OUTPUT_TOKENS',
    group: 'Chat',
    type: 'number',
    defaultValue: 2500,
    description: 'Responses API: max_output_tokens (output token budget).',
    constraints: { min: 1, max: 200000 },
  },
  {
    key: 'CHAT_TRUNCATION',
    group: 'Chat',
    type: 'string',
    defaultValue: 'disabled',
    description: 'Responses API: truncation strategy when context window exceeded (auto|disabled).',
    constraints: { enum: ['auto', 'disabled'] },
  },
  {
    key: 'CHAT_REASONING_EFFORT',
    group: 'Chat',
    type: 'string',
    defaultValue: null,
    description: 'Responses API: reasoning.effort for reasoning models (low|medium|high). Null = omit.',
    constraints: { enum: ['low', 'medium', 'high', null] },
  },

  // Certificate extraction (optional overrides)
  {
    key: 'CERT_EXTRACT_MODEL',
    group: 'Certificate extraction',
    type: 'string',
    defaultValue: 'gpt-5-mini',
    description: 'Model override for certificate OCR->JSON extraction.',
  },
  {
    key: 'CERT_EXTRACT_INSTRUCTIONS',
    group: 'Certificate extraction',
    type: 'string',
    defaultValue: [
      'You extract ATEX / IECEx certificate fields from OCR text for an industrial compliance system.',
      'Return STRICT JSON only (no markdown, no extra text).',
      'Do NOT translate field values.',
      'Do NOT invent values; if missing, return empty strings/false.',
      'Be robust to OCR noise (confusable characters, missing spaces, broken tokens).',
    ].join('\n'),
    description: 'Additional instructions for certificate extraction (optional).',
  },

  // Dataplate extraction (optional overrides)
  {
    key: 'DATAPLATE_EXTRACT_MODEL',
    group: 'Dataplate extraction',
    type: 'string',
    defaultValue: 'gpt-4o-mini',
    description: 'Model override for dataplate OCR->JSON extraction.',
  },
  {
    key: 'DATAPLATE_EXTRACT_INSTRUCTIONS',
    group: 'Dataplate extraction',
    type: 'string',
    defaultValue: [
      'You extract equipment dataplate fields from OCR text for an industrial safety system.',
      'Return STRICT JSON only (no markdown, no extra text).',
      'Do NOT invent values; if a field is not present, return empty string.',
      'Focus on accuracy over completeness.',
      'Be robust to OCR noise (confusable characters, missing spaces, broken tokens).',
    ].join('\n'),
    description: 'Additional instructions for dataplate extraction (optional).',
  },
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
