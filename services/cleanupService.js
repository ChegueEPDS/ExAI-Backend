const fs = require('fs');
const path = require('path');
const Conversation = require('../models/conversation');
const EquipmentBulkDeleteJob = require('../models/equipmentBulkDeleteJob');
const EquipmentImportJob = require('../models/equipmentImportJob');
const logger = require('../config/logger');
const azureBlob = require('./azureBlobService');
const systemSettings = require('./systemSettingsStore');

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

exports.cleanupEquipmentDocsImportErrorReports = async () => {
  try {
    const retentionDays = Number(systemSettings.getNumber('EQUIP_DOCS_IMPORT_ERROR_XLS_RETENTION_DAYS') || 7);
    if (!retentionDays) return;
    const olderThanMs = retentionDays * 24 * 60 * 60 * 1000;
    const prefix = 'equipment-docs-import-errors/';
    await azureBlob.deleteOldUnderPrefix(prefix, olderThanMs);
  } catch (err) {
    logger.warn('⚠️ Failed to cleanup equipment docs import error reports', err?.message || err);
  }
};

exports.cleanupEquipmentImportJobs = async () => {
  try {
    const retentionDays = Number(systemSettings.getNumber('EQUIPMENT_IMPORT_JOB_RETENTION_DAYS') || 30);
    if (!retentionDays || retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const jobs = await EquipmentImportJob.find({
      finishedAt: { $lte: cutoff },
      status: { $in: ['succeeded', 'failed'] }
    }).select('_id sourceBlobPath result.errorReportBlobPath').limit(100).lean();
    for (const job of jobs || []) {
      try {
        if (job.sourceBlobPath) await azureBlob.deleteFile(job.sourceBlobPath);
      } catch (err) {
        logger.warn('⚠️ Failed to cleanup equipment import source blob', err?.message || err);
      }
      try {
        if (job?.result?.errorReportBlobPath) await azureBlob.deleteFile(job.result.errorReportBlobPath);
      } catch (err) {
        logger.warn('⚠️ Failed to cleanup equipment import error blob', err?.message || err);
      }
      await EquipmentImportJob.deleteOne({ _id: job._id });
    }
  } catch (err) {
    logger.warn('⚠️ Failed to cleanup equipment import jobs', err?.message || err);
  }
};

exports.cleanupEquipmentBulkDeleteJobs = async () => {
  try {
    const retentionDays = Number(systemSettings.getNumber('EQUIPMENT_BULK_DELETE_JOB_RETENTION_DAYS') || 30);
    if (!retentionDays || retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await EquipmentBulkDeleteJob.deleteMany({
      finishedAt: { $lte: cutoff },
      status: { $in: ['succeeded', 'failed'] }
    });
  } catch (err) {
    logger.warn('⚠️ Failed to cleanup equipment bulk delete jobs', err?.message || err);
  }
};
