const DEFAULT_LOCALE = 'en';
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

function normalizeLocale(value) {
  const normalized = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  return LOCALE_PATTERN.test(normalized) ? normalized : '';
}

function configuredLocales() {
  const configured = String(process.env.SUPPORTED_UI_LOCALES || 'en,hu')
    .split(',')
    .map(normalizeLocale)
    .filter(Boolean);
  return [...new Set([DEFAULT_LOCALE, ...configured])];
}

function isSupportedLocale(value) {
  const normalized = normalizeLocale(value);
  return Boolean(normalized) && configuredLocales().includes(normalized);
}

function requestedPreferredLanguage(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LOCALE;
  return isSupportedLocale(value) ? normalizeLocale(value) : null;
}

module.exports = {
  DEFAULT_LOCALE,
  configuredLocales,
  isSupportedLocale,
  normalizeLocale,
  requestedPreferredLanguage,
};
