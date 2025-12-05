const Question = require('../models/questions'); // Mongoose model
const QuestionTypeMapping = require('../models/questionTypeMapping');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const fs = require('fs');

const PROTECTION_TYPE_VALUES = [
  "b", "c", "d", "da", "db", "dc", "e", "eb", "ec", "h", "i", "ia", "iaD", "ib", "ibD", "ic", "icD",
  "iD", "k", "m", "ma", "maD", "mb", "mbD", "mc", "mcD", "mD", "n", "nA", "nC", "nL", "nP", "nR",
  "o", "ob", "oc", "op", "op is", "op pr", "op sh", "p", "pb", "pc", "pD", "px", "pxb", "py", "pyb",
  "pz", "pzc", "q", "qb", "s", "sa", "sb", "sc", "t", "ta", "taD", "tb", "tbD", "tc", "tcD", "tD",
  "pv", "vc", "NA"
];
const PROTECTION_TYPE_SET = new Set(PROTECTION_TYPE_VALUES.map(v => v.toLowerCase()));

const INSPECTION_TYPE_MAP = new Map([
  ['close', 'Close'],
  ['detailed', 'Detailed'],
  ['visual', 'Visual']
]);

const EQUIPMENT_TYPES = [
  "General",
  "Motors",
  "Lighting",
  "Installation",
  "Installation Heating System",
  "Installation Motors",
  "Environment",
  "Equipment",
  "Additional Checks"
];
const EQUIPMENT_TYPE_SET = new Set(EQUIPMENT_TYPES.map(v => v.toLowerCase()));

const QUESTION_HEADER_CONFIG = [
  {
    key: '_id',
    note: 'Leave empty to create a new question. Keep the original value to update. If filled but not found, the row will fail.'
  },
  { key: 'questionText.eng', note: 'Required English text of the question.' },
  { key: 'questionText.hun', note: 'Optional Hungarian translation.' },
  { key: 'standard', note: 'Optional standard reference.' },
  { key: 'table', note: 'Optional table identifier.' },
  { key: 'group', note: 'Optional group identifier.' },
  { key: 'number', note: 'Optional numeric value. Use plain numbers (e.g. 12).' },
  {
    key: 'protectionTypes',
    note: 'Semicolon-separated list of protection types (e.g. d; e; ia). Values must match the allowed protection set.'
  },
  {
    key: 'inspectionTypes',
    note: 'Semicolon-separated list of inspection types (Close; Detailed; Visual). At least one required.'
  },
  {
    key: 'equipmentCategories',
    note: 'Semicolon-separated categories (e.g. Electrical; Non-Electrical). Stored as plain text.'
  },
  {
    key: 'equipmentType',
    note: `One of: ${EQUIPMENT_TYPES.join(', ')}.`
  }
];

function cellToString(value) {
  if (value == null) return '';
  if (value.text) return String(value.text).trim();
  if (typeof value === 'object' && value.richText) {
    return value.richText.map(part => part.text || '').join('').trim();
  }
  return String(value).trim();
}

function splitSemicolonList(value) {
  const raw = cellToString(value);
  if (!raw) return [];
  return raw
    .split(/[;,\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function isAdmin(req) {
  try {
    const role = req.role || req.user?.role;
    return role === 'Admin' || role === 'SuperAdmin';
  } catch {
    return false;
  }
}

// Új kérdés(ek) hozzáadása
const addQuestion = async (req, res) => {
    try {
        const data = Array.isArray(req.body) ? req.body : [req.body];
        const savedQuestions = await Question.insertMany(data);

        res.status(201).json({
            message: `${savedQuestions.length} question(s) added successfully.`,
            data: savedQuestions
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Kérdések lekérdezése opcionális szűrőkkel
const getQuestions = async (req, res) => {
    const { protectionType, inspectionType, equipmentCategory } = req.query;
  
    const filter = {};
  
    if (protectionType) {
      const types = Array.isArray(protectionType) ? protectionType : [protectionType];
  
      // 👇 Regex minden protectionType-ra (kisbetű-független)
      filter.protectionTypes = {
        $in: types.map(type => new RegExp(`^${type}$`, 'i'))
      };
    }
  
    if (inspectionType) {
      filter.inspectionTypes = inspectionType;
    }
  
    if (equipmentCategory) {
      filter.equipmentCategories = { $in: [equipmentCategory, 'All'] };
    }
  
    try {
      const questions = await Question.find(filter);
      res.status(200).json(questions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

// Egy kérdés frissítése
const updateQuestion = async (req, res) => {
    try {
        const updated = await Question.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ error: "Question not found" });
        }

        res.status(200).json(updated);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Egy kérdés törlése
const deleteQuestion = async (req, res) => {
    try {
        const deleted = await Question.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: "Question not found" });
        }
        res.status(200).json({ message: "Question deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ---- QuestionTypeMapping CRUD (tenant-level; Admin + SuperAdmin) ----

const listQuestionTypeMappings = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }

    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
    const mappings = await QuestionTypeMapping.find({ tenantId: tenantObjectId })
      .sort({ createdAt: 1 })
      .lean();

    return res.json(mappings);
  } catch (err) {
    console.error('❌ listQuestionTypeMappings error:', err);
    return res.status(500).json({
      message: 'Failed to list question type mappings.',
      error: err.message || String(err)
    });
  }
};

const createQuestionTypeMapping = async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res
        .status(403)
        .json({ message: 'Only Admin / SuperAdmin can manage question type mappings.' });
    }

    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }
    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);

    const { label, equipmentPattern, equipmentTypes, active } = req.body || {};
    if (
      !equipmentPattern ||
      !Array.isArray(equipmentTypes) ||
      !equipmentTypes.length
    ) {
      return res.status(400).json({
        message: 'equipmentPattern and equipmentTypes are required.'
      });
    }

    const mapping = await QuestionTypeMapping.create({
      tenantId: tenantObjectId,
      label,
      equipmentPattern,
      equipmentTypes,
      active: active !== undefined ? !!active : true
    });

    return res.status(201).json(mapping);
  } catch (err) {
    console.error('❌ createQuestionTypeMapping error:', err);
    return res.status(400).json({
      message: 'Failed to create question type mapping.',
      error: err.message || String(err)
    });
  }
};

const updateQuestionTypeMapping = async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res
        .status(403)
        .json({ message: 'Only Admin / SuperAdmin can manage question type mappings.' });
    }

    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }
    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
    const { id } = req.params;

    const update = { ...req.body };
    delete update.tenantId;

    const updated = await QuestionTypeMapping.findOneAndUpdate(
      { _id: id, tenantId: tenantObjectId },
      { $set: update },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Mapping not found.' });
    }

    return res.json(updated);
  } catch (err) {
    console.error('❌ updateQuestionTypeMapping error:', err);
    return res.status(400).json({
      message: 'Failed to update question type mapping.',
      error: err.message || String(err)
    });
  }
};

const deleteQuestionTypeMapping = async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res
        .status(403)
        .json({ message: 'Only Admin / SuperAdmin can manage question type mappings.' });
    }

    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ message: 'Missing tenantId from auth.' });
    }
    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
    const { id } = req.params;

    const deleted = await QuestionTypeMapping.findOneAndDelete({
      _id: id,
      tenantId: tenantObjectId
    });

    if (!deleted) {
      return res.status(404).json({ message: 'Mapping not found.' });
    }

    return res.json({ message: 'Mapping deleted.' });
  } catch (err) {
    console.error('❌ deleteQuestionTypeMapping error:', err);
    return res.status(500).json({
      message: 'Failed to delete question type mapping.',
      error: err.message || String(err)
    });
  }
};

const exportQuestionsXLSX = async (req, res) => {
  try {
    const role = req.role || req.user?.role;
    if (role !== 'SuperAdmin') {
      return res.status(403).json({ message: 'Only SuperAdmin can export questions.' });
    }

    const questions = await Question.find({})
      .sort({ table: 1, group: 1, number: 1, createdAt: 1 })
      .lean();

    if (!questions.length) {
      return res.status(404).json({ message: 'No questions found for export.' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Questions');

    const headers = [
      '_id',
      'questionText.eng',
      'questionText.hun',
      'standard',
      'table',
      'group',
      'number',
      'protectionTypes',
      'inspectionTypes',
      'equipmentCategories',
      'equipmentType'
    ];

    worksheet.addRow(headers);
    const headerRow = worksheet.getRow(1);
    headerRow.height = 24;
    headerRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDDEBF7' }
      };
      const headerKey = headers[colNumber - 1];
      const headerDef = QUESTION_HEADER_CONFIG.find(h => h.key === headerKey);
      if (headerDef?.note) {
        cell.note = headerDef.note;
      }
    });

    questions.forEach(q => {
      const rowValues = [
        q._id ? q._id.toString() : '',
        q.questionText?.eng || '',
        q.questionText?.hun || '',
        q.standard || '',
        q.table || '',
        q.group || '',
        q.number != null ? q.number : '',
        Array.isArray(q.protectionTypes) ? q.protectionTypes.join('; ') : '',
        Array.isArray(q.inspectionTypes) ? q.inspectionTypes.join('; ') : '',
        Array.isArray(q.equipmentCategories)
          ? q.equipmentCategories.join('; ')
          : (q.equipmentCategories || ''),
        q.equipmentType || ''
      ];
      worksheet.addRow(rowValues);
    });

    worksheet.columns.forEach(column => {
      column.width = 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="questions.xlsx"'
    );
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('❌ exportQuestionsXLSX error:', err);
    return res.status(500).json({
      message: 'Failed to export questions.',
      error: err.message || String(err)
    });
  }
};

const importQuestionsXLSX = async (req, res) => {
  const tenantId = req.scope?.tenantId;
  const tenantName = req.scope?.tenantName || '';
  const file = req.file;

  if (!tenantId) {
    return res.status(401).json({ message: 'Missing tenantId from auth.' });
  }
  if (!file) {
    return res.status(400).json({ message: 'Missing XLSX file (field name: file).' });
  }

  const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
  const errors = [];
  let createdCount = 0;
  let updatedCount = 0;

  try {
    const originalFileBuffer = await fs.promises.readFile(file.path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(originalFileBuffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ message: 'The uploaded workbook does not contain any worksheet.' });
    }

    const headerRow = worksheet.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, columnNumber) => {
      const value = cellToString(cell?.value || '');
      if (value) {
        headerMap[value.toLowerCase()] = columnNumber;
      }
    });

    const requiredHeaders = [
      '_id',
      'questiontext.eng',
      'questiontext.hun',
      'standard',
      'table',
      'group',
      'number',
      'protectiontypes',
      'inspectiontypes',
      'equipmentcategories',
      'equipmenttype'
    ];

    const missingHeader = requiredHeaders.find(h => headerMap[h] == null);
    if (missingHeader) {
      return res.status(400).json({ message: `Missing column in header: ${missingHeader}` });
    }

    const rowStart = 2;
    for (let i = rowStart; i <= worksheet.rowCount; i += 1) {
      const row = worksheet.getRow(i);
      if (!row || row.cellCount === 0) continue;

      const eng = cellToString(row.getCell(headerMap['questiontext.eng']).value);
      const hun = cellToString(row.getCell(headerMap['questiontext.hun']).value);
      const standard = cellToString(row.getCell(headerMap['standard']).value);
      const tableVal = cellToString(row.getCell(headerMap['table']).value);
      const groupVal = cellToString(row.getCell(headerMap['group']).value);
      const numberRaw = cellToString(row.getCell(headerMap['number']).value);
      const protectionRaw = row.getCell(headerMap['protectiontypes']).value;
      const inspectionRaw = row.getCell(headerMap['inspectiontypes']).value;
      const equipmentCategoriesRaw = cellToString(row.getCell(headerMap['equipmentcategories']).value);
      const equipmentTypeRaw = cellToString(row.getCell(headerMap['equipmenttype']).value);
      const idRaw = cellToString(row.getCell(headerMap['_id']).value);

      const isRowEmpty = !eng && !hun && !standard && !tableVal && !groupVal && !numberRaw &&
        !cellToString(protectionRaw) && !cellToString(inspectionRaw) && !equipmentCategoriesRaw && !equipmentTypeRaw;
      if (isRowEmpty) {
        continue;
      }

      if (!eng) {
        errors.push({ row: i, message: 'questionText.eng is required.' });
        continue;
      }

      const protectionTypes = splitSemicolonList(protectionRaw).map(value => value.toLowerCase());
      const invalidProtection = protectionTypes.find(pt => !PROTECTION_TYPE_SET.has(pt));
      if (invalidProtection) {
        errors.push({
          row: i,
          message: `Invalid protection type: ${invalidProtection}`
        });
        continue;
      }

      const normalizedProtectionTypes = protectionTypes.map(pt => {
        const index = PROTECTION_TYPE_VALUES.findIndex(v => v.toLowerCase() === pt);
        return index >= 0 ? PROTECTION_TYPE_VALUES[index] : pt;
      });

      if (!normalizedProtectionTypes.length) {
        errors.push({ row: i, message: 'At least one protection type is required.' });
        continue;
      }

      const inspectionTypes = splitSemicolonList(inspectionRaw).map(value => value.toLowerCase());
      if (!inspectionTypes.length) {
        errors.push({ row: i, message: 'At least one inspection type is required.' });
        continue;
      }
      const normalizedInspection = [];
      let inspectionError = null;
      for (const insp of inspectionTypes) {
        const canonical = INSPECTION_TYPE_MAP.get(insp);
        if (!canonical) {
          inspectionError = insp;
          break;
        }
        if (!normalizedInspection.includes(canonical)) {
          normalizedInspection.push(canonical);
        }
      }
      if (inspectionError) {
        errors.push({ row: i, message: `Invalid inspection type: ${inspectionError}` });
        continue;
      }

      let numberValue = null;
      if (numberRaw) {
        const parsed = Number(numberRaw);
        if (Number.isNaN(parsed)) {
          errors.push({ row: i, message: 'Number column must be numeric.' });
          continue;
        }
        numberValue = parsed;
      }

      let equipmentType = '';
      if (equipmentTypeRaw) {
        const key = equipmentTypeRaw.toLowerCase();
        if (!EQUIPMENT_TYPE_SET.has(key)) {
          errors.push({
            row: i,
            message: `Invalid equipmentType: ${equipmentTypeRaw}`
          });
          continue;
        }
        const canonical = EQUIPMENT_TYPES.find(et => et.toLowerCase() === key);
        equipmentType = canonical || equipmentTypeRaw;
      }

      const updateDoc = {
        questionText: {
          eng,
          hun
        },
        standard: standard || undefined,
        table: tableVal || undefined,
        group: groupVal || undefined,
        number: numberValue,
        protectionTypes: normalizedProtectionTypes,
        inspectionTypes: normalizedInspection,
        equipmentCategories: equipmentCategoriesRaw || undefined,
        equipmentType: equipmentType || undefined
      };

      const role = req.role || req.user?.role;
      const isSuperAdmin = role === 'SuperAdmin';

      if (idRaw) {
        if (!mongoose.Types.ObjectId.isValid(idRaw)) {
          errors.push({ row: i, message: `Invalid _id value: ${idRaw}` });
          continue;
        }

        const query = { _id: idRaw };
        if (!isSuperAdmin) {
          query.tenantId = tenantObjectId;
        }
        const existing = await Question.findOne(query);
        if (!existing) {
          errors.push({ row: i, message: `Question not found for _id ${idRaw}` });
          continue;
        }

        await Question.findByIdAndUpdate(
          existing._id,
          { $set: updateDoc },
          { new: true }
        );
        updatedCount += 1;
      } else {
        await Question.create({
          ...updateDoc,
          tenantId: tenantObjectId
        });
        createdCount += 1;
      }
    }

    if (errors.length > 0) {
      try {
        const workbookOut = new ExcelJS.Workbook();
        await workbookOut.xlsx.load(originalFileBuffer);
        const worksheet = workbookOut.worksheets[0];

        const summarySheet = workbookOut.addWorksheet('Import summary');
        summarySheet.addRow(['Created', createdCount]);
        summarySheet.addRow(['Updated', updatedCount]);
        summarySheet.addRow(['Error rows', errors.length]);
        summarySheet.getColumn(1).width = 15;
        summarySheet.getColumn(2).width = 12;

        const errorFill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC0C0' }
        };

        errors.forEach(err => {
          const rowNumber = err?.row;
          if (!rowNumber || !worksheet) return;
          const row = worksheet.getRow(rowNumber);
          row.eachCell(cell => {
            cell.fill = errorFill;
          });
          const noteCell = worksheet.getCell(`A${rowNumber}`);
          const existingNote = typeof noteCell.note === 'string' && noteCell.note.length
            ? `${noteCell.note}\n`
            : '';
          noteCell.note = `${existingNote}${err.message || 'Invalid data in this row.'}`;
        });

        const buffer = await workbookOut.xlsx.writeBuffer();
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="questions-import-errors.xlsx"'
        );
        return res.status(200).send(Buffer.from(buffer));
      } catch (excelErr) {
        console.warn('⚠️ Failed to generate error XLSX for questions import:', excelErr?.message || excelErr);
        // fall through to JSON response below
      }
    }

    return res.json({
      message: 'Questions import completed.',
      createdCount,
      updatedCount,
      errors
    });
  } catch (err) {
    console.error('❌ importQuestionsXLSX error:', err);
    return res.status(500).json({
      message: 'Failed to import questions.',
      error: err.message || String(err)
    });
  } finally {
    try {
      if (file?.path) {
        fs.unlinkSync(file.path);
      }
    } catch {}
  }
};

module.exports = {
  addQuestion,
  getQuestions,
  updateQuestion,
  deleteQuestion,
  listQuestionTypeMappings,
  createQuestionTypeMapping,
  updateQuestionTypeMapping,
  deleteQuestionTypeMapping,
  exportQuestionsXLSX,
  importQuestionsXLSX
};
