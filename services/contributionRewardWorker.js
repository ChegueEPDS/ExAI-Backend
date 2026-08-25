const Stripe = require('stripe');
const ContributionReward = require('../models/contributionReward');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const Certificate = require('../models/certificate');
const mailService = require('./mailService');
const mailTemplates = require('./mailTemplates');
const systemSettings = require('./systemSettingsStore');
const { buildRedeemLinks } = require('./contributionRewardService');
const automatedEmailService = require('./automatedEmailService');

function stripeClient() {
  return process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
    : null;
}

function positiveSetting(key, fallback) {
  const value = Number(systemSettings.getNumber(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function markRedeemedFromStripe(reward, stripe, now) {
  const promo = await stripe.promotionCodes.retrieve(String(reward.stripePromotionCodeId));
  const update = { lastStripeSyncAt: now };
  if (Number(promo?.times_redeemed || 0) > 0) {
    update.status = 'redeemed';
    update.redeemedAt = reward.redeemedAt || now;
  } else if ((reward.expiresAt && reward.expiresAt <= now) || (promo?.expires_at && promo.expires_at * 1000 <= now.getTime())) {
    update.status = 'expired';
    update.expiredAt = reward.expiredAt || now;
  }
  await ContributionReward.updateOne({ _id: reward._id }, { $set: update });
  return update.status || reward.status;
}

async function sendRewardReminder(reward, { finalReminder }) {
  const [user, tenant] = await Promise.all([
    User.findById(reward.userId).select('email firstName').lean(),
    reward.tenantId ? Tenant.findById(reward.tenantId).select('name').lean() : null,
  ]);
  if (!user?.email) return false;
  const links = buildRedeemLinks({ reward, userId: reward.userId, tenantName: tenant?.name });
  const html = mailTemplates.contributionRewardReminderEmail({
    firstName: user.firstName,
    milestone: reward.milestone,
    code: reward.promoCode,
    expiresAt: reward.expiresAt,
    redeemUrl: links.redeemUrl,
    finalReminder,
  }, tenant?.name);
  await mailService.sendMail({
    to: user.email,
    subject: finalReminder ? 'Your free Team month expires soon' : 'Your free Team month is waiting',
    html,
  });
  await ContributionReward.updateOne(
    { _id: reward._id },
    { $set: finalReminder ? { expiryReminderSentAt: new Date() } : { reminderSentAt: new Date() } }
  );
  return true;
}

async function sweepContributionRewards({ now = new Date(), limit = 250 } = {}) {
  const stripe = stripeClient();
  if (!stripe) return { skipped: true, reason: 'stripe_not_configured' };
  const reminderDays = positiveSetting('CONTRIBUTION_REWARD_REMINDER_DAYS', 10);
  const expiryReminderDays = positiveSetting('CONTRIBUTION_REWARD_EXPIRY_REMINDER_DAYS', 3);
  const candidates = await ContributionReward.find({
    status: { $in: ['issued', 'emailed'] },
    stripePromotionCodeId: { $exists: true, $ne: '' },
  }).sort({ expiresAt: 1 }).limit(limit);
  let redeemed = 0;
  let expired = 0;
  let reminders = 0;
  for (const reward of candidates) {
    try {
      const status = await markRedeemedFromStripe(reward, stripe, now);
      if (status === 'redeemed') { redeemed++; continue; }
      if (status === 'expired') { expired++; continue; }
      const issuedAt = reward.initialEmailSentAt || reward.emailedAt || reward.createdAt;
      const ageMs = now - issuedAt;
      const untilExpiryMs = reward.expiresAt ? reward.expiresAt - now : Infinity;
      const finalDue = !reward.expiryReminderSentAt && untilExpiryMs <= expiryReminderDays * 86400000;
      const regularDue = !reward.reminderSentAt && ageMs >= reminderDays * 86400000;
      if (finalDue || regularDue) {
        if (await sendRewardReminder(reward, { finalReminder: finalDue })) reminders++;
      }
    } catch (e) {
      await ContributionReward.updateOne(
        { _id: reward._id },
        { $set: { lastError: `sweep: ${e?.message || e}`, lastStripeSyncAt: now } }
      );
    }
  }
  return { ok: true, checked: candidates.length, redeemed, expired, reminders };
}

async function sweepHalfwayMilestones({ limit = 250 } = {}) {
  const step = positiveSetting('CONTRIBUTION_REWARD_STEP', 20);
  const halfway = Math.ceil(step / 2);
  const users = await User.find({ tenantId: { $ne: null } }).select('_id email firstName tenantId').limit(limit).lean();
  let sent = 0;
  for (const user of users) {
    const tenant = await Tenant.findById(user.tenantId).select('name seatsManaged stripeCustomerId').lean();
    if (!tenant || tenant.seatsManaged !== 'stripe' || !tenant.stripeCustomerId) continue;
    const count = await Certificate.countDocuments({ createdBy: user._id });
    const cycleStart = Math.floor(count / step) * step;
    const target = cycleStart + step;
    if (count !== cycleStart + halfway) continue;
    const result = await automatedEmailService.sendContributionHalfway({
      userId: user._id,
      currentCount: count,
      milestone: target,
    });
    if (result.ok) sent++;
  }
  return { ok: true, sent, step };
}

module.exports = { sweepContributionRewards, sweepHalfwayMilestones, markRedeemedFromStripe };
