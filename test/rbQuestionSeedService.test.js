const test = require('node:test');
const assert = require('node:assert/strict');

const Question = require('../models/questions');
const { buildRbQuestionSeedDocuments } = require('../services/rbQuestionSeedService');

test('RB question seed contains sanitized global questions', () => {
  const questions = buildRbQuestionSeedDocuments();

  assert.equal(questions.length, 404);
  assert.ok(questions.every((question) => question.tenantId === null));
  assert.ok(questions.every((question) => question.questionText?.eng));
  assert.ok(questions.every((question) => question.protectionTypes.length > 0));
  assert.ok(questions.every((question) => question.inspectionTypes.length > 0));
  assert.ok(questions.every((question) => question._id === undefined));
  assert.ok(questions.every((question) => !new Question(question).validateSync()));
});
