const axios = require('axios');
const logger = require('../config/logger');

const categorizeMessageUsingAI = async (message, assistantMessage) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Categorize the conversation into one of the following categories: ATEX, Ex markings, Hazardous Area Classification, Explosion protection, ATEX137, ATEX114, 60079-0, 60079-10-1, 60079-10-2, Legal, Fire Proterction, Work safety, Viresol, PGMED, Uncategorized. Only return the category name!',
          },
          { 
            role: 'user', 
            content: `User: ${message}\nAssistant: ${assistantMessage}`
          }
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );
    const aiResponse = response.data.choices[0].message.content.trim();
    logger.info(`AI Categorization result: ${aiResponse}`);
    return aiResponse;
  } catch (error) {
    logger.error(`Hiba történt a kategorizálás során: ${error.message}`);
    return 'Nem kategorizált';
  }
};

module.exports = categorizeMessageUsingAI;
