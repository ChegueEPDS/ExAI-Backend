const Question = require('../models/questions');
const seedQuestions = require('../data/rb-questions.seed.json');
const { withLock } = require('./distributedLockService');

function buildRbQuestionSeedDocuments() {
  return seedQuestions.map((question) => ({
    questionText: question.questionText,
    standard: question.standard || '',
    table: question.table || '',
    group: question.group || '',
    number: question.number ?? null,
    protectionTypes: Array.isArray(question.protectionTypes) ? question.protectionTypes : [],
    inspectionTypes: Array.isArray(question.inspectionTypes) ? question.inspectionTypes : [],
    equipmentCategories: question.equipmentCategories || '',
    equipmentType: question.equipmentType,
    tenantId: null
  }));
}

async function seedRbQuestionsIfEmpty() {
  return withLock('seed-rb-questions', 60_000, async () => {
    if (await Question.exists({})) return { seeded: false, reason: 'not_empty' };

    const documents = buildRbQuestionSeedDocuments();
    for (const document of documents) {
      const validationError = new Question(document).validateSync();
      if (validationError) throw validationError;
    }
    await Question.insertMany(documents, { ordered: true });
    return { seeded: true, count: documents.length };
  });
}

module.exports = { buildRbQuestionSeedDocuments, seedRbQuestionsIfEmpty };
