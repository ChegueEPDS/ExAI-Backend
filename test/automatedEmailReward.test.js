const test = require('node:test');
const assert = require('node:assert/strict');

const { getDefinition } = require('../config/systemSettingsRegistry');
const mailTemplates = require('../services/mailTemplates');
const { isEmailMarketingAllowed } = require('../services/emailMarketingPreference');
const { selectFreeLifecycleEmail } = require('../services/automatedEmailEligibility');
const ContributionReward = require('../models/contributionReward');
const AutomationEmailLog = require('../models/automationEmailLog');
const EmailConsentLog = require('../models/emailConsentLog');
const User = require('../models/user');
const brevoService = require('../services/brevoService');
const emailPreferenceService = require('../services/emailPreferenceService');

test('contribution reward settings use SuperAdmin defaults without an env dependency', () => {
  assert.equal(getDefinition('CONTRIBUTION_REWARD_STEP').defaultValue, 20);
  assert.equal(getDefinition('CONTRIBUTION_REWARD_PROMO_TTL_DAYS').defaultValue, 30);
  assert.equal(getDefinition('CONTRIBUTION_REWARD_REMINDER_DAYS').defaultValue, 10);
  assert.equal(getDefinition('CONTRIBUTION_REWARD_EXPIRY_REMINDER_DAYS').defaultValue, 3);
});

test('automatic marketing emails are disabled by default until SuperAdmin enables them', () => {
  assert.equal(getDefinition('AUTOMATED_MARKETING_EMAILS_ENABLED').defaultValue, false);
  assert.equal(getDefinition('AUTOMATED_EMAIL_BATCH_SIZE').defaultValue, 10);
});

test('contribution reward model tracks redemption, expiry and reminders', () => {
  const statusValues = ContributionReward.schema.path('status').enumValues;
  assert.ok(statusValues.includes('redeemed'));
  assert.ok(statusValues.includes('expired'));
  assert.ok(ContributionReward.schema.path('redeemedAt'));
  assert.ok(ContributionReward.schema.path('reminderSentAt'));
  assert.ok(ContributionReward.schema.path('expiryReminderSentAt'));
});

test('automation email log has a per-user deduplication index', () => {
  const indexes = AutomationEmailLog.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.userId === 1 && fields.dedupeKey === 1 && options.unique === true
  ));
});

test('cookie consent does not control the separate email marketing preference', () => {
  assert.equal(isEmailMarketingAllowed({ marketingEmailsEnabled: true, marketing: 'denied' }), true);
  assert.equal(isEmailMarketingAllowed({ marketingEmailsEnabled: false, marketing: 'granted' }), false);
  assert.equal(isEmailMarketingAllowed({}), true);
});

test('email preferences default to enabled English communications', () => {
  assert.equal(User.schema.path('marketingEmailsEnabled').defaultValue, true);
  assert.equal(User.schema.path('newsletterEmailsEnabled').defaultValue, true);
  assert.equal(User.schema.path('preferredLanguage').defaultValue, 'en');
  const response = emailPreferenceService.preferenceResponse({});
  assert.deepEqual(response.systemMessages, { enabled: true, mutable: false });
  assert.equal(response.usefulInformation.enabled, true);
  assert.equal(response.newsletter.enabled, true);
  assert.equal(response.preferredLanguage, 'en');
});

test('Brevo managed lists keep useful information independent from newsletters', () => {
  const lists = brevoService.getManagedEmailLists();
  assert.equal(lists.newsletter.en, 6);
  assert.equal(lists.newsletter.hu, 7);
  assert.equal(lists.usefulInformation, 8);
  assert.equal(brevoService.newsletterListForLanguage('en'), 6);
  assert.equal(brevoService.newsletterListForLanguage('hu'), 7);
});

test('email consent log records category, source and synchronization result', () => {
  assert.deepEqual(EmailConsentLog.schema.path('category').enumValues, ['useful_information', 'newsletter']);
  assert.ok(EmailConsentLog.schema.path('source').enumValues.includes('brevo_webhook'));
  assert.ok(EmailConsentLog.schema.path('syncStatus').enumValues.includes('failed'));
});

test('users without a recorded last login enter the age-based onboarding step', () => {
  assert.equal(selectFreeLifecycleEmail({ ageDays: 2, lastLoginAt: null, downloads: 0 }), null);
  assert.equal(
    selectFreeLifecycleEmail({ ageDays: 3, lastLoginAt: null, downloads: 0 }),
    'onboarding_day_3'
  );
  assert.equal(
    selectFreeLifecycleEmail({ ageDays: 10, downloads: 0 }),
    'onboarding_day_10'
  );
  assert.equal(
    selectFreeLifecycleEmail({ ageDays: 20, lastLoginAt: null, downloads: 0 }),
    'onboarding_day_20'
  );
  assert.equal(
    selectFreeLifecycleEmail({ ageDays: 2000, lastLoginAt: undefined, downloads: 5 }),
    'onboarding_day_20'
  );
});

test('halfway email renders configured milestone values dynamically', () => {
  const html = mailTemplates.contributionHalfwayEmail({
    firstName: 'Ada',
    currentCount: 25,
    milestone: 50,
  }, 'atex');
  assert.match(html, /25/);
  assert.match(html, /50/);
  assert.match(html, /Ada/);
});

test('marketing emails always use ATEXdb branding and links', () => {
  const html = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Welcome',
    paragraphs: ['Test'],
    ctaLabel: 'Open',
    ctaUrl: 'https://exai.ind-ex.ae/account',
  }, 'index');
  assert.match(html, /public\/ATEXdb\.png/);
  assert.match(html, /https:\/\/certs\.atexdb\.eu\/account/);
  assert.doesNotMatch(html, /index_logo\.png/);
  assert.doesNotMatch(html, /https:\/\/exai\.ind-ex\.ae\/account/);
});

test('system emails resolve IndEx branding from the public domain', () => {
  const html = mailTemplates.forgotPasswordEmailHtml({
    firstName: 'Ada',
    lastName: 'Lovelace',
    loginUrl: 'https://exai.ind-ex.ae/login',
    tempPassword: 'Test-1234',
    tenantName: 'some-tenant',
    baseUrl: 'https://exai.ind-ex.ae',
  });
  assert.match(html, /index_logo\.png/);
  assert.match(html, /ExAI IndEx/);
  assert.match(html, /https:\/\/exai\.ind-ex\.ae\/login/);
  assert.match(html, /#fff100/i);
  assert.match(html, /Operated by EPDS Kft\./);
  assert.doesNotMatch(html, /1154 Budapest, Kozák tér 13-16\./);
  assert.doesNotMatch(html, /mailto:info@epds\.hu/);
  assert.match(html, /Company registration number: 01 09 291697/);
  assert.match(html, /Tax number: 25834138-2-42/);
});

test('system emails resolve ATEXdb branding from the certs domain', () => {
  const html = mailTemplates.emailVerificationEmailHtml({
    firstName: 'Ada',
    lastName: 'Lovelace',
    verifyUrl: 'https://certs.atexdb.eu/verify-email?token=test',
    tenantName: 'index',
    baseUrl: 'https://certs.atexdb.eu',
  });
  assert.match(html, /public\/ATEXdb\.png/);
  assert.match(html, /ATEXdb Certs/);
  assert.match(html, /© \d{4} ATEXdb by EPDS\. All rights reserved\./);
  assert.doesNotMatch(html, /© \d{4} ATEXdb Certs\./);
  assert.match(html, /Operated by EPDS Kft\./);
  assert.doesNotMatch(html, /1154 Budapest, Kozák tér 13-16\./);
  assert.doesNotMatch(html, /mailto:info@epds\.hu/);
  assert.match(html, /Company registration number: 01 09 291697/);
  assert.match(html, /Tax number: 25834138-2-42/);
  assert.doesNotMatch(html, /index_logo\.png/);
});

test('system login buttons use the real login route when given only an origin', () => {
  const html = mailTemplates.forgotPasswordEmailHtml({
    firstName: 'Ada',
    loginUrl: 'https://certs.atexdb.eu',
    tempPassword: 'Test-1234',
    baseUrl: 'https://certs.atexdb.eu',
  });
  assert.match(html, /href="https:\/\/certs\.atexdb\.eu\/login"/);
});

test('marketing CTAs use existing certificate and account routes', () => {
  const uploadHtml = mailTemplates.contributionHalfwayEmail({
    firstName: 'Ada',
    currentCount: 10,
    milestone: 20,
  }, 'index');
  const upgradeHtml = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Upgrade',
    ctaLabel: 'Upgrade',
    ctaPath: 'account?upgrade=pro',
  }, 'index');
  assert.match(uploadHtml, /href="https:\/\/certs\.atexdb\.eu\/cert\?tab=upload"/);
  assert.match(upgradeHtml, /href="https:\/\/certs\.atexdb\.eu\/account\?upgrade=pro"/);
});

test('join invitation buttons preserve the real token route and reject action', () => {
  const html = mailTemplates.tenantJoinInviteEmailHtml({
    firstName: 'Ada',
    tenantName: 'Example',
    acceptUrl: 'https://certs.atexdb.eu/join-invite/token-123',
    rejectUrl: 'https://certs.atexdb.eu/join-invite/token-123?action=reject',
    baseUrl: 'https://certs.atexdb.eu',
  });
  assert.match(html, /https:\/\/certs\.atexdb\.eu\/join-invite\/token-123/);
  assert.match(html, /https:\/\/certs\.atexdb\.eu\/join-invite\/token-123\?action=reject/);
});

test('every reward reminder states the promotion code expiry date', () => {
  const expiresAt = new Date('2030-05-17T00:00:00.000Z');
  const regular = mailTemplates.contributionRewardReminderEmail({
    firstName: 'Ada',
    milestone: 20,
    code: 'TEST-CODE',
    expiresAt,
    finalReminder: false,
  });
  const final = mailTemplates.contributionRewardReminderEmail({
    firstName: 'Ada',
    milestone: 20,
    code: 'TEST-CODE',
    expiresAt,
    finalReminder: true,
  });
  assert.match(regular, /expires on <strong>2030-05-17<\/strong>/);
  assert.match(final, /expires on <strong>2030-05-17<\/strong>/);
});

test('Pro and Team promotions reserve labelled image slots for core features', () => {
  const pro = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Upgrade to Pro',
    features: mailTemplates.PRO_EMAIL_FEATURES,
  });
  const team = mailTemplates.contributionRewardEmail({
    firstName: 'Ada',
    milestone: 20,
    code: 'TEST-CODE',
    expiresAt: new Date('2030-05-17T00:00:00.000Z'),
  });
  assert.match(pro, /data-email-image-slot="email-pro-unlimited-downloads\.webp"/);
  assert.match(pro, /Unlimited certificate downloads/);
  assert.match(team, /data-email-image-slot="email-team-collaboration\.webp"/);
  assert.match(team, /Projects and reports/);
});

test('Team welcome email mirrors Pro welcome with Team-specific benefits', () => {
  const html = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Welcome to ATEXdb Team',
    paragraphs: ['Your Team workspace is ready.'],
    features: mailTemplates.TEAM_EMAIL_FEATURES,
    ctaLabel: 'Open your Team account',
    ctaPath: 'account',
  });
  assert.match(html, /Hi Ada,/);
  assert.match(html, /Welcome to ATEXdb Team/);
  assert.match(html, /A shared workspace for your team/);
  assert.match(html, /Central certificate management/);
  assert.match(html, /Projects and reports/);
  assert.match(html, /href="https:\/\/certs\.atexdb\.eu\/account"/);
});

test('automated reward emails use the same first-name greeting and safe fallback', () => {
  const named = mailTemplates.contributionRewardEmail({
    firstName: 'Ada',
    lastName: 'Lovelace',
    milestone: 20,
    code: 'TEST-CODE',
  });
  const fallback = mailTemplates.contributionRewardEmail({
    milestone: 20,
    code: 'TEST-CODE',
  });
  assert.match(named, /Hi Ada,/);
  assert.doesNotMatch(named, /Dear Ada Lovelace,/);
  assert.match(fallback, /Hi there,/);
});

test('day 3 onboarding markets downloads, rewarded contributions and community requests', () => {
  const html = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Get more from ATEXdb in 3 simple steps',
    features: mailTemplates.ATEXDB_START_FEATURES,
    ctaLabel: 'Explore ATEXdb',
    ctaPath: 'cert?tab=db',
  });
  assert.match(html, /data-email-image-slot="email-start-download-certificate\.webp"/);
  assert.match(html, /Download the certificate you need/);
  assert.match(html, /counts towards your next free Team month/);
  assert.match(html, /community can help locate and share it/);
  assert.match(html, /href="https:\/\/certs\.atexdb\.eu\/cert\?tab=db"/);
});

test('first activity emails reuse the matching getting-started images', () => {
  const firstDownload = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Your first certificate is ready',
    features: [mailTemplates.ATEXDB_START_FEATURES[0]],
    ctaLabel: 'Open ATEXdb',
    ctaPath: 'cert?tab=db',
  });
  const firstUpload = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Thank you for your first upload',
    features: [mailTemplates.ATEXDB_START_FEATURES[1]],
    ctaLabel: 'Upload more certificates',
    ctaPath: 'cert?tab=upload',
  });
  assert.match(firstDownload, /data-email-image-slot="email-start-download-certificate\.webp"/);
  assert.match(firstUpload, /data-email-image-slot="email-start-contribute-upload\.webp"/);
  assert.match(firstDownload, /href="https:\/\/certs\.atexdb\.eu\/cert\?tab=db"/);
  assert.match(firstUpload, /href="https:\/\/certs\.atexdb\.eu\/cert\?tab=upload"/);
});

test('inactive lifecycle email presents the full ATEXdb value proposition', () => {
  const html = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Make the most of ATEXdb',
    features: mailTemplates.ATEXDB_ACCESS_FEATURES,
    ctaLabel: 'Open ATEXdb',
    ctaPath: 'cert?tab=db',
  });
  assert.match(html, /Find verified ATEX certificates/);
  assert.match(html, /Ask the community for missing documents/);
  assert.match(html, /Upload and organise your certificates/);
  assert.match(html, /Understand documents with AI support/);
});

test('fifth-download Pro promotion uses feature cards and the real upgrade route', () => {
  const html = mailTemplates.automatedLifecycleEmail({
    firstName: 'Ada',
    heading: 'Turn your downloads into an organised certificate database',
    paragraphs: ['You have already downloaded five certificates with your Free subscription — a great start.'],
    features: mailTemplates.PRO_EMAIL_FEATURES,
    ctaLabel: 'Organise your certificates with Pro',
    ctaPath: 'account?upgrade=pro',
  });
  assert.match(html, /downloaded five certificates/);
  assert.match(html, /Your own certificate database/);
  assert.match(html, /href="https:\/\/certs\.atexdb\.eu\/account\?upgrade=pro"/);
});
