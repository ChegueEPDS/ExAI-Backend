const Conversation = require('../models/conversation');
const logger = require('../config/logger');

exports.removeEmptyConversations = async () => {
  try {
    const result = await Conversation.deleteMany({ "messages.0": { $exists: false } });
    if (result.deletedCount > 0) {
      logger.info(`${result.deletedCount} üres beszélgetés törölve.`);
    } else {
      logger.info('Nincsenek üres beszélgetések.');
    }
  } catch (error) {
    logger.error('Hiba az üres beszélgetések törlése során:', error.message);
  }
};
