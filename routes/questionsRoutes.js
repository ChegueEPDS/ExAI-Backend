const questionsController = require('../controllers/questionsController');
const authMiddleware = require('../middlewares/authMiddleware');
const express = require('express');
const { diskUpload } = require('../middlewares/uploadFactory');
const upload = diskUpload({ fileSizeMb: 20, files: 1, fields: 20 });

const router = express.Router();

// Legacy question CRUD (no auth attached here – kept as-is)
router.post('/', questionsController.addQuestion);
router.get('/', questionsController.getQuestions);
router.put('/:id', questionsController.updateQuestion);
router.delete('/:id', questionsController.deleteQuestion);

router.get(
  '/export-xlsx',
  authMiddleware(),
  questionsController.exportQuestionsXLSX
);

router.post(
  '/import-xlsx',
  authMiddleware(),
  upload.single('file'),
  questionsController.importQuestionsXLSX
);

// QuestionTypeMapping CRUD – tenant-level, Admin/SuperAdmin only
router.get(
  '/mappings',
  authMiddleware(),
  questionsController.listQuestionTypeMappings
);

router.post(
  '/mappings',
  authMiddleware(),
  questionsController.createQuestionTypeMapping
);

router.put(
  '/mappings/:id',
  authMiddleware(),
  questionsController.updateQuestionTypeMapping
);

router.delete(
  '/mappings/:id',
  authMiddleware(),
  questionsController.deleteQuestionTypeMapping
);

module.exports = router;
