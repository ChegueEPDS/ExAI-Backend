const fs = require('fs');
const path = require('path');
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

exports.cleanupDxfResults = () => {
  const resultDir = path.resolve('results');
  let files;

  try {
    files = fs.readdirSync(resultDir);
  } catch (err) {
    logger.warn(`Nem található a results mappa: ${resultDir}`);
    return;
  }

  const now = Date.now();
  const maxAgeMs = 3 * 60 * 60 * 1000; // 3 óra

  const groups = {
    excel: [],
    json: []
  };

  for (const file of files) {
    const fullPath = path.join(resultDir, file);

    if (file.startsWith('output_') && file.endsWith('.xlsx')) {
      const { birthtimeMs } = fs.statSync(fullPath);
      groups.excel.push({ path: fullPath, time: birthtimeMs });
    }

    if (file.startsWith('debug_unknowns_') && file.endsWith('.json')) {
      const { birthtimeMs } = fs.statSync(fullPath);
      groups.json.push({ path: fullPath, time: birthtimeMs });
    }
  }

  for (const group of Object.values(groups)) {
    if (group.length <= 1) continue;

    group.sort((a, b) => b.time - a.time);
    const [, ...oldFiles] = group;

    for (const file of oldFiles) {
      if ((now - file.time) > maxAgeMs) {
        try {
          fs.unlinkSync(file.path);
          logger.info(`🧹 DXF fájl törölve: ${file.path}`);
        } catch (err) {
          logger.warn(`⚠️ Nem sikerült törölni: ${file.path} - ${err.message}`);
        }
      }
    }
  }
};