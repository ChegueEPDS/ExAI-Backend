const AutomationEmailLog = require('../models/automationEmailLog');
const Certificate = require('../models/certificate');
const CertificateRequest = require('../models/certificateRequest');
const DownloadQuota = require('../models/downloadQuota');
const Tenant = require('../models/tenant');
const User = require('../models/user');
const mailService = require('./mailService');
const mailTemplates = require('./mailTemplates');
const systemSettings = require('./systemSettingsStore');
const { isEmailMarketingAllowed } = require('./emailMarketingPreference');
const { selectFreeLifecycleEmail } = require('./automatedEmailEligibility');

const DAY = 86400000;

const DEFINITIONS = {
  onboarding_day_3: {
    subject: 'Find, share and request certificates with ATEXdb',
    heading: 'Get more from ATEXdb in 3 simple steps',
    paragraphs: ['Your free ATEXdb account is ready. Find the documents you need, help grow the shared database and let the community help when a certificate is missing.'],
    features: mailTemplates.ATEXDB_START_FEATURES,
    ctaLabel: 'Explore ATEXdb',
    ctaPath: 'cert?tab=db',
  },
  onboarding_day_10: {
    subject: 'Can’t find a certificate?',
    heading: 'Can’t find the certificate you need?',
    paragraphs: [
      'Your ATEXdb account gives you more than search access. If a certificate is missing, you do not have to stop there.',
      'Publish a certificate request and let the ATEXdb community help locate and share the document. A community response can help you move forward faster, while making the certificate available to everyone who may need it later.',
    ],
    features: [mailTemplates.ATEXDB_START_FEATURES[2]],
    ctaLabel: 'Log in and request a certificate',
    ctaPath: 'cert?tab=db',
  },
  onboarding_day_20: {
    subject: 'How can we help you get started using ATEXdb?',
    heading: 'How can we help you get started?',
    paragraphs: [
      'We noticed that you have not logged in or downloaded a certificate recently, so we wanted to check in.',
      'Is it difficult to find the right certificate, unclear how to begin, or simply not the right time yet?',
      'Reply to this email and tell us what is stopping you. Your feedback helps us support you better and show you a practical way to get value from your free ATEXdb subscription.',
    ],
  },
  inactive_30_days: {
    subject: 'Maximise your ATEXdb access',
    heading: 'Make the most of ATEXdb',
    paragraphs: [
      'You have access to ATEXdb — a platform built to help you find verified ATEX certificates, request missing documents and manage your certificate information in one place.',
      'Everything is ready when you need it. Why not return today and make your next certificate task simpler?',
    ],
    features: mailTemplates.ATEXDB_ACCESS_FEATURES,
    ctaLabel: 'Open ATEXdb',
    ctaPath: 'cert?tab=db',
  },
  free_fifth_download: {
    subject: 'Build your own certificate database with ATEXdb',
    heading: 'Turn your downloads into an organised certificate database',
    paragraphs: [
      'You have already downloaded five certificates with your Free subscription — a great start.',
      'With ATEXdb Pro, you can keep the certificates you use organised in your own searchable database, access them more easily and continue downloading without the Free-plan daily limit.',
    ],
    features: mailTemplates.PRO_EMAIL_FEATURES,
    ctaLabel: 'Organise your certificates with Pro',
    ctaPath: 'account?upgrade=pro',
  },
  first_download: {
    subject: 'You downloaded your first certificate',
    heading: 'Your first certificate is ready',
    paragraphs: ['Congratulations on downloading your first certificate. You can now continue searching or start organising your own certificate collection.'],
    features: [mailTemplates.ATEXDB_START_FEATURES[0]],
    ctaLabel: 'Open ATEXdb',
    ctaPath: 'cert?tab=db',
  },
  daily_limit_reached: {
    subject: 'Need more downloads? Upgrade to Pro',
    heading: 'You reached your daily download limit',
    paragraphs: ['Upgrade to Pro to keep downloading certificates without interruption and organise them in your own database.'],
    features: mailTemplates.PRO_EMAIL_FEATURES,
    ctaLabel: 'Upgrade to Pro',
    ctaPath: 'account?upgrade=pro',
  },
  first_upload: {
    subject: 'Your upload helps the whole community',
    heading: 'Thank you for your first upload',
    paragraphs: ['Your contribution makes the certificate database stronger and more useful for everyone. Keep uploading to earn a free Team month.'],
    features: [mailTemplates.ATEXDB_START_FEATURES[1]],
    ctaLabel: 'Upload more certificates',
    ctaPath: 'cert?tab=upload',
  },
  pro_welcome: {
    subject: 'Welcome to ATEXdb Pro',
    heading: 'Welcome to ATEXdb Pro',
    paragraphs: ['You now have unlimited daily downloads, your own certificate database and access to the ExAI assistant.'],
    features: mailTemplates.PRO_EMAIL_FEATURES,
    ctaLabel: 'Open your account',
    ctaPath: 'account',
  },
  team_welcome: {
    subject: 'Welcome to ATEXdb Team',
    heading: 'Welcome to ATEXdb Team',
    paragraphs: [
      'Your Team workspace is ready. You can now invite colleagues, manage your organisation’s certificates in one shared place and use the advanced ATEXdb tools together.',
    ],
    features: mailTemplates.TEAM_EMAIL_FEATURES,
    ctaLabel: 'Open your Team account',
    ctaPath: 'account',
  },
};

function getLifecycleEmailCatalog() {
  return Object.entries(DEFINITIONS).map(([key, value]) => ({
    key,
    label: value.subject,
    category: key === 'pro_welcome' || key === 'team_welcome' ? 'service' : 'marketing',
  }));
}

function renderLifecycleTestEmail(type, { firstName = 'Test', tenantName = 'ATEXdb' } = {}) {
  const definition = DEFINITIONS[type];
  if (!definition) return null;
  return {
    subject: `[TEST] ${definition.subject}`,
    html: mailTemplates.automatedLifecycleEmail({ firstName, ...definition }, tenantName),
  };
}

function positiveSetting(key, fallback) {
  const value = Number(systemSettings.getNumber(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function reserveAndSend({
  user,
  tenant,
  type,
  dedupeKey = type,
  category = 'marketing',
  meta = {},
  allowDisabledMarketing = false,
}) {
  const definition = DEFINITIONS[type];
  if (!definition || !user?.email || !tenant?.stripeCustomerId) return { skipped: true, reason: 'ineligible' };
  if (user.emailDeliverySuppressed) return { skipped: true, reason: 'delivery_suppressed' };
  if (category === 'marketing') {
    if (
      !allowDisabledMarketing &&
      systemSettings.getBoolean('AUTOMATED_MARKETING_EMAILS_ENABLED') === false
    ) {
      return { skipped: true, reason: 'disabled' };
    }
    // Cookie consent and email marketing preference are separate legal choices.
    // Only the dedicated user-level email preference controls marketing emails.
    if (!isEmailMarketingAllowed(user)) {
      return { skipped: true, reason: 'marketing_email_disabled' };
    }
    const now = new Date();
    const [weekly, monthly] = await Promise.all([
      AutomationEmailLog.countDocuments({ userId: user._id, category: 'marketing', status: 'sent', sentAt: { $gte: new Date(now - 7 * DAY) } }),
      AutomationEmailLog.countDocuments({ userId: user._id, category: 'marketing', status: 'sent', sentAt: { $gte: new Date(now - 30 * DAY) } }),
    ]);
    if (weekly >= positiveSetting('AUTOMATED_EMAIL_WEEKLY_CAP', 1)) return { skipped: true, reason: 'weekly_cap' };
    if (monthly >= positiveSetting('AUTOMATED_EMAIL_MONTHLY_CAP', 3)) return { skipped: true, reason: 'monthly_cap' };
  }
  let log;
  try {
    log = await AutomationEmailLog.create({ userId: user._id, tenantId: tenant._id, type, dedupeKey, category, status: 'reserved', meta });
  } catch (e) {
    if (e?.code === 11000) return { skipped: true, reason: 'already_processed' };
    throw e;
  }
  try {
    const html = mailTemplates.automatedLifecycleEmail({ firstName: user.firstName, ...definition }, tenant.name);
    await mailService.sendMail({ to: user.email, subject: definition.subject, html });
    await AutomationEmailLog.updateOne({ _id: log._id }, { $set: { status: 'sent', sentAt: new Date() } });
    return { ok: true };
  } catch (e) {
    await AutomationEmailLog.updateOne({ _id: log._id }, { $set: { status: 'failed', lastError: e?.message || String(e) } });
    return { skipped: true, reason: 'send_failed' };
  }
}

async function sendEventEmail({ userId, type, dedupeKey, category = 'marketing', meta = {} }) {
  const user = await User.findById(userId).select('email firstName tenantId marketingEmailsEnabled emailDeliverySuppressed').lean();
  const tenant = user?.tenantId ? await Tenant.findById(user.tenantId).select('name plan stripeCustomerId seatsManaged').lean() : null;
  return reserveAndSend({ user, tenant, type, dedupeKey, category, meta });
}

async function queueEventEmail({ userId, type, dedupeKey = type, category = 'marketing', delayMs = 0, meta = {} }) {
  if (
    category === 'marketing' &&
    systemSettings.getBoolean('AUTOMATED_MARKETING_EMAILS_ENABLED') === false
  ) {
    return { skipped: true, reason: 'disabled' };
  }
  const user = await User.findById(userId).select('tenantId').lean();
  if (!user?.tenantId) return { skipped: true, reason: 'missing_tenant' };
  const tenant = await Tenant.findById(user.tenantId).select('stripeCustomerId seatsManaged').lean();
  if (!tenant?.stripeCustomerId || tenant.seatsManaged !== 'stripe') return { skipped: true, reason: 'ineligible' };
  try {
    await AutomationEmailLog.create({
      userId,
      tenantId: tenant._id,
      type,
      dedupeKey,
      category,
      status: 'queued',
      availableAt: new Date(Date.now() + Math.max(0, Number(delayMs) || 0)),
      meta,
    });
    return { ok: true, queued: true };
  } catch (e) {
    if (e?.code === 11000) return { skipped: true, reason: 'already_processed' };
    throw e;
  }
}

async function sweepQueuedEmails({ now = new Date(), limit } = {}) {
  const batchSize = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : positiveSetting('AUTOMATED_EMAIL_BATCH_SIZE', 10);
  const queued = await AutomationEmailLog.find({ status: 'queued', availableAt: { $lte: now } })
    .sort({ category: -1, availableAt: 1 })
    .limit(batchSize);
  let sent = 0;
  for (const item of queued) {
    const [user, tenant] = await Promise.all([
      User.findById(item.userId).select('email firstName tenantId marketingEmailsEnabled emailDeliverySuppressed').lean(),
      Tenant.findById(item.tenantId).select('name plan stripeCustomerId seatsManaged').lean(),
    ]);
    await AutomationEmailLog.deleteOne({ _id: item._id, status: 'queued' });
    const result = await reserveAndSend({
      user,
      tenant,
      type: item.type,
      dedupeKey: item.dedupeKey,
      category: item.category,
      meta: item.meta || {},
      allowDisabledMarketing: true,
    });
    if (result.ok) sent++;
    if (result.reason === 'weekly_cap' || result.reason === 'monthly_cap') {
      const retryDelay = result.reason === 'weekly_cap' ? 7 * DAY : 30 * DAY;
      try {
        await AutomationEmailLog.create({
          userId: item.userId,
          tenantId: item.tenantId,
          type: item.type,
          dedupeKey: item.dedupeKey,
          category: item.category,
          status: 'queued',
          availableAt: new Date(now.getTime() + retryDelay),
          meta: item.meta || {},
        });
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }
  }
  return { ok: true, checked: queued.length, sent, batchSize };
}

async function activityCounts(userId) {
  const [uploads, downloads, requests] = await Promise.all([
    Certificate.countDocuments({ createdBy: userId }),
    DownloadQuota.aggregate([{ $match: { userId } }, { $group: { _id: null, count: { $sum: '$count' } } }]),
    CertificateRequest.countDocuments({ createdBy: userId }),
  ]);
  return { uploads, downloads: Number(downloads?.[0]?.count || 0), requests };
}

async function sweepLifecycleEmails({ now = new Date(), limit = 500 } = {}) {
  if (systemSettings.getBoolean('AUTOMATED_MARKETING_EMAILS_ENABLED') === false) {
    return { skipped: true, reason: 'disabled', checked: 0, queued: 0 };
  }
  const users = await User.find({ tenantId: { $ne: null } }).select('email firstName tenantId createdAt lastLoginAt marketingEmailsEnabled emailDeliverySuppressed').limit(limit).lean();
  let queued = 0;
  for (const user of users) {
    const tenant = await Tenant.findById(user.tenantId).select('name plan stripeCustomerId seatsManaged').lean();
    if (!tenant?.stripeCustomerId || tenant.seatsManaged !== 'stripe') continue;
    const ageDays = Math.floor((now - user.createdAt) / DAY);
    const counts = await activityCounts(user._id);
    let type = null;
    if (tenant.plan === 'free') {
      type = selectFreeLifecycleEmail({
        ageDays,
        lastLoginAt: user.lastLoginAt,
        downloads: counts.downloads,
      });
    }
    const lastActivity = user.lastLoginAt || user.createdAt;
    const inactiveDays = Math.floor((now - lastActivity) / DAY);
    if (!type && inactiveDays >= 30 && inactiveDays < 90) {
      const cycle = Math.floor(inactiveDays / 30);
      type = 'inactive_30_days';
      const result = await queueEventEmail({ userId: user._id, type, dedupeKey: `${type}:${cycle}` });
      if (result.ok) queued++;
      continue;
    }
    if (type) {
      const result = await queueEventEmail({ userId: user._id, type });
      if (result.ok) queued++;
    }
  }
  return { ok: true, queued, checked: users.length };
}

async function sendContributionHalfway({ userId, currentCount, milestone }) {
  const user = await User.findById(userId).select('email firstName tenantId marketingEmailsEnabled emailDeliverySuppressed').lean();
  const tenant = user?.tenantId ? await Tenant.findById(user.tenantId).select('name stripeCustomerId seatsManaged').lean() : null;
  if (!user?.email || !tenant?.stripeCustomerId || tenant.seatsManaged !== 'stripe') return { skipped: true, reason: 'ineligible' };
  if (user.emailDeliverySuppressed) return { skipped: true, reason: 'delivery_suppressed' };
  if (systemSettings.getBoolean('AUTOMATED_MARKETING_EMAILS_ENABLED') === false) return { skipped: true, reason: 'disabled' };
  if (!isEmailMarketingAllowed(user)) return { skipped: true, reason: 'marketing_email_disabled' };
  const dedupeKey = `contribution_halfway:${milestone}`;
  let log;
  try {
    log = await AutomationEmailLog.create({
      userId,
      tenantId: tenant._id,
      type: 'contribution_halfway',
      dedupeKey,
      category: 'marketing',
      status: 'reserved',
      meta: { currentCount, milestone },
    });
  } catch (e) {
    if (e?.code === 11000) return { skipped: true, reason: 'already_processed' };
    throw e;
  }
  try {
    const html = mailTemplates.contributionHalfwayEmail({ firstName: user.firstName, currentCount, milestone }, tenant.name);
    await mailService.sendMail({ to: user.email, subject: 'You’re halfway to your free Team month', html });
    await AutomationEmailLog.updateOne({ _id: log._id }, { $set: { status: 'sent', sentAt: new Date() } });
    return { ok: true };
  } catch (e) {
    await AutomationEmailLog.updateOne({ _id: log._id }, { $set: { status: 'failed', lastError: e?.message || String(e) } });
    return { skipped: true, reason: 'send_failed' };
  }
}

module.exports = {
  sendEventEmail,
  queueEventEmail,
  sweepQueuedEmails,
  sweepLifecycleEmails,
  reserveAndSend,
  activityCounts,
  sendContributionHalfway,
  getLifecycleEmailCatalog,
  renderLifecycleTestEmail,
};
