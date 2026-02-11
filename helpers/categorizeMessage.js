const axios = require('axios');
const logger = require('../config/logger');
const { createResponse, extractOutputTextFromResponse } = require('./openaiResponses');

const categorizeMessageUsingAI = async (message, assistantMessage) => {
  try {
    const allowed = [
      'ATEX',
      'Ex markings',
      'Hazardous Area Classification',
      'Explosion protection',
      'ATEX137',
      'ATEX114',
      '60079-0',
      '60079-10-1',
      '60079-10-2',
      '60079-14',
      '60079-17 Legal',
      'Fire Proterction',
      'Work safety',
      'Viresol',
      'PGMED',
      'Uncategorized',
    ];

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: allowed },
      },
      required: ['category'],
    };

    const respObj = await createResponse({
      model: 'gpt-4o-mini',
      instructions:
        'Categorize the conversation into one of the allowed categories. ' +
        'Return STRICT JSON only.',
      input: [{
        role: 'user',
        content: `User: ${message}\nAssistant: ${assistantMessage || ''}`,
      }],
      store: false,
      temperature: 0,
      maxOutputTokens: 120,
      textFormat: { type: 'json_schema', name: 'category', strict: true, schema },
      timeoutMs: 30_000,
    });

    const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
    const parsed = JSON.parse(txt);
    const aiResponse = String(parsed?.category || '').trim();
    logger.info(`AI Categorization result: ${aiResponse}`);
    return allowed.includes(aiResponse) ? aiResponse : 'Uncategorized';
  } catch (error) {
    logger.error('Hiba történt a kategorizálás során:', {
      message: error?.message || String(error),
      status: error?.response?.status || null,
      data: error?.response?.data || null,
    });
    return 'Uncategorized';
  }
};

module.exports = categorizeMessageUsingAI;
