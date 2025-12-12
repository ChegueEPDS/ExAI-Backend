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

exports.cleanupUploadTempFiles = (maxAgeMsOverride) => {
  const uploadDir = path.resolve('uploads');
  let files;

  try {
    files = fs.readdirSync(uploadDir);
  } catch (err) {
    logger.warn(`Nem található az uploads mappa: ${uploadDir}`);
    return;
  }

  const now = Date.now();
  const maxAgeMsDefault = 3 * 60 * 60 * 1000; // 3 óra – régi, félbehagyott feltöltések törlése
  const maxAgeMs = typeof maxAgeMsOverride === 'number' && maxAgeMsOverride >= 0
    ? maxAgeMsOverride
    : maxAgeMsDefault;

  for (const file of files) {
    const fullPath = path.join(uploadDir, file);

    // Hagyjuk békén a "normális", kiterjesztéses fájlokat (png, xlsx, stb.)
    const hasExtension = file.includes('.');

    // A multer által generált ideiglenes nevek tipikusan 16+ hex karakter, kiterjesztés nélkül.
    const looksLikeMulterTemp = !hasExtension && /^[a-f0-9]{16,}$/.test(file);

    // Plusz: ha valami .zip kiterjesztésű (pl. direkt így mentettük), azt is tekinthetjük temp-nek.
    const isZip = file.toLowerCase().endsWith('.zip');

    if (!looksLikeMulterTemp && !isZip) {
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.birthtimeMs > maxAgeMs) {
        try {
          fs.unlinkSync(fullPath);
          logger.info(`🧹 Feltöltési ideiglenes fájl törölve: ${fullPath}`);
        } catch (err) {
          logger.warn(`⚠️ Nem sikerült törölni az ideiglenes feltöltési fájlt: ${fullPath} - ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`⚠️ Nem sikerült stat-olni az ideiglenes feltöltési fájlt: ${fullPath} - ${err.message}`);
    }
  }
};
