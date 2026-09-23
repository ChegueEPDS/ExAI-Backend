const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LOCALE,
  configuredLocales,
  isSupportedLocale,
  normalizeLocale,
} = require('../config/supportedLocales');
const User = require('../models/user');
const { responseFor } = require('../controllers/userPreferenceController');

test('locale normalization uses lowercase BCP 47-style values', () => {
  assert.equal(normalizeLocale('HU_hu'), 'hu-hu');
  assert.equal(normalizeLocale(' de-DE '), 'de-de');
  assert.equal(normalizeLocale('../hu'), '');
});

test('configured UI locales always include the default locale', () => {
  const previous = process.env.SUPPORTED_UI_LOCALES;
  process.env.SUPPORTED_UI_LOCALES = 'hu,de-DE';
  try {
    assert.deepEqual(configuredLocales(), ['en', 'hu', 'de-de']);
    assert.equal(isSupportedLocale('DE_de'), true);
    assert.equal(isSupportedLocale('fr'), false);
  } finally {
    if (previous === undefined) delete process.env.SUPPORTED_UI_LOCALES;
    else process.env.SUPPORTED_UI_LOCALES = previous;
  }
});

test('user preferredLanguage keeps a safe default and validates configured locales', () => {
  assert.equal(User.schema.path('preferredLanguage').defaultValue, DEFAULT_LOCALE);
  assert.equal(responseFor({ preferredLanguage: 'hu' }).preferredLanguage, 'hu');
  assert.equal(responseFor({ preferredLanguage: '' }).preferredLanguage, 'en');
});
