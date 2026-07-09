const multer = require('multer');

const MB = 1024 * 1024;

function buildLimits({
  fileSizeMb = 25,
  files = 10,
  fields = 100,
  parts,
  fieldSizeMb = 1,
} = {}) {
  const safeFiles = Math.max(1, Number(files) || 1);
  const safeFields = Math.max(1, Number(fields) || 1);
  return {
    fileSize: Math.max(1, Number(fileSizeMb) || 1) * MB,
    files: safeFiles,
    fields: safeFields,
    fieldSize: Math.max(1, Number(fieldSizeMb) || 1) * MB,
    parts: Math.max(1, Number(parts) || safeFiles + safeFields + 10),
  };
}

function diskUpload(options = {}) {
  const { dest = 'uploads/', ...limitOptions } = options;
  return multer({
    dest,
    limits: buildLimits(limitOptions),
  });
}

function memoryUpload(options = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: buildLimits(options),
  });
}

function customUpload({ storage, fileFilter, ...limitOptions } = {}) {
  return multer({
    storage,
    fileFilter,
    limits: buildLimits(limitOptions),
  });
}

module.exports = {
  MB,
  buildLimits,
  customUpload,
  diskUpload,
  memoryUpload,
};
