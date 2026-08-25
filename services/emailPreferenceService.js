const User = require('../models/user');
const EmailConsentLog = require('../models/emailConsentLog');
const brevoService = require('./brevoService');

const CATEGORIES = Object.freeze({
  usefulInformation: 'useful_information',
  newsletter: 'newsletter',
});

function normalizeLanguage(value) {
  return String(value || '').toLowerCase() === 'hu' ? 'hu' : 'en';
}

function preferenceResponse(user) {
  return {
    systemMessages: { enabled: true, mutable: false },
    usefulInformation: {
      enabled: user?.marketingEmailsEnabled !== false,
      mutable: true,
      syncStatus: user?.emailPreferenceSync?.usefulInformation?.status || 'pending',
    },
    newsletter: {
      enabled: user?.newsletterEmailsEnabled !== false,
      mutable: true,
      syncStatus: user?.emailPreferenceSync?.newsletter?.status || 'pending',
    },
    preferredLanguage: normalizeLanguage(user?.preferredLanguage),
  };
}

function syncStateUpdate(status, error = '') {
  return { status, lastAttemptAt: new Date(), lastError: String(error || '').slice(0, 2000) };
}

async function createConsentLog({ user, category, previousEnabled, enabled, source, listIds, syncStatus, syncError, context = {} }) {
  return EmailConsentLog.create({
    userId: user._id,
    email: user.email,
    category,
    previousEnabled,
    enabled,
    source,
    language: normalizeLanguage(user.preferredLanguage),
    brevoListIds: listIds || [],
    syncStatus,
    syncError: String(syncError || '').slice(0, 2000),
    requestId: context.requestId || '',
    ip: context.ip || '',
    userAgent: context.userAgent || '',
  });
}

async function syncUser(user, { source = 'sync_retry', changed = [], syncCategories = changed, previous = {}, context = {} } = {}) {
  const result = await brevoService.syncEmailPreferences({
    email: user.email,
    usefulInformationEnabled: user.marketingEmailsEnabled !== false,
    newsletterEnabled: user.newsletterEmailsEnabled !== false,
    preferredLanguage: normalizeLanguage(user.preferredLanguage),
    restoreNewsletterListIds: user.brevoNewsletterListIds || [],
  });
  const ok = result?.ok === true;
  const error = ok ? '' : (result?.error || result?.reason || 'Brevo synchronization failed');
  const status = ok ? 'synced' : (result?.skipped ? 'pending' : 'failed');
  const remembered = Array.isArray(result?.rememberedNewsletterListIds) && result.rememberedNewsletterListIds.length
    ? result.rememberedNewsletterListIds
    : (user.brevoNewsletterListIds || []);

  if (changed.includes('newsletter') && user.newsletterEmailsEnabled === false && remembered.length) {
    user.brevoNewsletterListIds = remembered;
  }
  user.emailPreferenceSync = user.emailPreferenceSync || {};
  if (syncCategories.includes('usefulInformation') || source === 'sync_retry') {
    user.emailPreferenceSync.usefulInformation = syncStateUpdate(status, error);
  }
  if (syncCategories.includes('newsletter') || source === 'sync_retry') {
    user.emailPreferenceSync.newsletter = syncStateUpdate(status, error);
  }
  await user.save();

  for (const key of changed) {
    await createConsentLog({
      user,
      category: CATEGORIES[key],
      previousEnabled: previous[key],
      enabled: key === 'usefulInformation' ? user.marketingEmailsEnabled !== false : user.newsletterEmailsEnabled !== false,
      source,
      listIds: key === 'newsletter' ? remembered : [brevoService.getManagedEmailLists().usefulInformation],
      syncStatus: status,
      syncError: error,
      context,
    });
  }
  return { ok, status, error };
}

async function updatePreferences(userId, input, { source = 'settings', context = {} } = {}) {
  const user = await User.findById(userId);
  if (!user) return { notFound: true };
  const previous = {
    usefulInformation: user.marketingEmailsEnabled !== false,
    newsletter: user.newsletterEmailsEnabled !== false,
  };
  const changed = [];
  const syncCategories = [];
  user.emailPreferenceSync = user.emailPreferenceSync || {};
  if (typeof input.usefulInformationEnabled === 'boolean' && input.usefulInformationEnabled !== previous.usefulInformation) {
    user.marketingEmailsEnabled = input.usefulInformationEnabled;
    user.emailPreferenceSync.usefulInformation = syncStateUpdate('pending');
    changed.push('usefulInformation');
    syncCategories.push('usefulInformation');
  }
  if (typeof input.newsletterEnabled === 'boolean' && input.newsletterEnabled !== previous.newsletter) {
    user.newsletterEmailsEnabled = input.newsletterEnabled;
    user.emailPreferenceSync.newsletter = syncStateUpdate('pending');
    changed.push('newsletter');
    syncCategories.push('newsletter');
  }
  const language = normalizeLanguage(input.preferredLanguage ?? user.preferredLanguage);
  const languageChanged = language !== normalizeLanguage(user.preferredLanguage);
  if (languageChanged) {
    user.preferredLanguage = language;
    user.emailPreferenceSync.newsletter = syncStateUpdate('pending');
    if (!syncCategories.includes('newsletter')) syncCategories.push('newsletter');
  }
  await user.save();
  if (syncCategories.length) await syncUser(user, { source, changed, syncCategories, previous, context });
  return { user, preferences: preferenceResponse(user) };
}

async function recordInitialPreferences(user, { source = 'registration', context = {} } = {}) {
  if (!user?._id || !user?.email) return;
  const managed = brevoService.getManagedEmailLists();
  const syncResult = await brevoService.syncEmailPreferences({
    email: user.email,
    usefulInformationEnabled: user.marketingEmailsEnabled !== false,
    newsletterEnabled: user.newsletterEmailsEnabled !== false,
    preferredLanguage: normalizeLanguage(user.preferredLanguage),
  });
  const syncOk = syncResult?.ok === true;
  const syncError = syncOk ? '' : (syncResult?.error || syncResult?.reason || 'Brevo synchronization failed');
  const syncStatus = syncOk ? 'synced' : (syncResult?.skipped ? 'pending' : 'failed');
  user.emailPreferenceSync = user.emailPreferenceSync || {};
  user.emailPreferenceSync.usefulInformation = syncStateUpdate(syncStatus, syncError);
  user.emailPreferenceSync.newsletter = syncStateUpdate(syncStatus, syncError);
  await user.save();
  const rows = [
    {
      category: 'useful_information',
      enabled: user.marketingEmailsEnabled !== false,
      listIds: [managed.usefulInformation],
    },
    {
      category: 'newsletter',
      enabled: user.newsletterEmailsEnabled !== false,
      listIds: [brevoService.newsletterListForLanguage(normalizeLanguage(user.preferredLanguage))],
    },
  ];
  for (const row of rows) {
    await createConsentLog({
      user,
      category: row.category,
      previousEnabled: false,
      enabled: row.enabled,
      source,
      listIds: row.listIds,
      syncStatus,
      syncError,
      context,
    });
  }
}

async function sweepPendingEmailPreferenceSync({ limit = 100 } = {}) {
  const users = await User.find({
    $or: [
      { 'emailPreferenceSync.usefulInformation.status': { $in: ['pending', 'failed'] } },
      { 'emailPreferenceSync.newsletter.status': { $in: ['pending', 'failed'] } },
    ],
  }).limit(limit);
  let synced = 0;
  for (const user of users) {
    const result = await syncUser(user, { source: 'sync_retry' });
    if (result.ok) synced++;
  }
  return { ok: true, checked: users.length, synced };
}

module.exports = {
  normalizeLanguage,
  preferenceResponse,
  updatePreferences,
  recordInitialPreferences,
  sweepPendingEmailPreferenceSync,
};
