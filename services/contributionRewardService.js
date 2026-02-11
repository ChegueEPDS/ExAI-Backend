// services/contributionRewardService.js
const Stripe = require('stripe');
const logger = require('../config/logger');

const Certificate = require('../models/certificate');
const ContributionReward = require('../models/contributionReward');
const User = require('../models/user');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');

const mailService = require('./mailService');
const mailTemplates = require('./mailTemplates');
const { createOneTimeTeamPromoCode, buildPromoCode } = require('./stripeContributionDiscountService');
const { ensureStripeCustomerForTenant } = require('./stripeCustomerProvisioning');
const systemSettings = require('./systemSettingsStore');

function log(level, message, meta) {
  try {
    if (logger && typeof logger[level] === 'function') {
      return logger[level](`${message}${meta ? ' ' + JSON.stringify(meta) : ''}`);
    }
  } catch {}
  try {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](message, meta || '');
  } catch {}
}

function getStripeClient() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return null;
  return new Stripe(stripeKey, { apiVersion: '2024-06-20' });
}

function isEligibleStripeTenant({ tenant, sub }) {
  if (!tenant) return { ok: false, reason: 'missing_tenant' };
  if (tenant.seatsManaged !== 'stripe') return { ok: false, reason: 'manual_license' };

  const tier = (sub?.tier || tenant.plan || '').toString().toLowerCase();
  // Allow free users too (goal: incentivize subscription).
  if (!['free', 'pro', 'team'].includes(tier)) return { ok: false, reason: 'unknown_tier' };

  const status = (sub?.status || '').toString().toLowerCase();
  // If user already has a subscription snapshot, require it to be in a usable state.
  if (status && !['active', 'trialing', 'past_due', 'incomplete'].includes(status)) return { ok: false, reason: 'inactive_subscription' };

  return { ok: true, tier, status };
}

async function issueMilestoneReward({ userId, milestone, forceResendEmail = false }) {
  const stripe = getStripeClient();
  if (!stripe) return { skipped: true, reason: 'stripe_not_configured' };

  const user = await User.findById(userId).select('email firstName lastName tenantId').lean();
  if (!user) return { skipped: true, reason: 'user_not_found' };
  if (!user.email) return { skipped: true, reason: 'missing_email' };
  if (!user.tenantId) return { skipped: true, reason: 'missing_tenantId' };

  const tenantDoc = await Tenant.findById(user.tenantId);
  const sub = tenantDoc ? await Subscription.findOne({ tenantId: tenantDoc._id }).lean() : null;
  const elig = isEligibleStripeTenant({ tenant: tenantDoc, sub });
  if (!elig.ok) return { skipped: true, reason: elig.reason };

  // Free users may not have Stripe customer yet; create and cache it on the tenant.
  let stripeCustomerId = tenantDoc?.stripeCustomerId || null;
  if (!stripeCustomerId) {
    stripeCustomerId = await ensureStripeCustomerForTenant({ stripe, tenantDoc, user });
  }
  if (!stripeCustomerId) return { skipped: true, reason: 'missing_stripe_customer' };

  // Idempotency: create reward doc; duplicates fall back to existing record (allow retries on failures).
  let rewardDoc = null;
  try {
    rewardDoc = await ContributionReward.create({
      userId,
      tenantId: tenantDoc?._id,
      milestone,
      stripeCustomerId,
      status: 'pending',
    });
  } catch (e) {
    // Duplicate key -> already issued/attempted for this milestone; load existing and possibly retry.
    if (e && (e.code === 11000 || /duplicate key/i.test(String(e.message || '')))) {
      rewardDoc = await ContributionReward.findOne({ userId, milestone });
      if (!rewardDoc) return { skipped: true, reason: 'already_issued' };
    }
    else throw e;
  }

  try {
    // If already has a code, don't create a new promo code. Only (re)send email if needed.
    if (rewardDoc.promoCode && ['issued', 'emailed'].includes(String(rewardDoc.status || ''))) {
      if (String(rewardDoc.status) === 'emailed' && !forceResendEmail) {
        return { skipped: true, reason: 'already_emailed' };
      }

      const subject = 'Thank you — your 100% Team discount code';
      const html = mailTemplates.contributionRewardEmail(
        {
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          milestone,
          code: rewardDoc.promoCode,
          expiresAt: rewardDoc.expiresAt || null,
        },
        tenantDoc?.name || undefined
      );

      try {
        await mailService.sendMail({ to: user.email, subject, html });
        await ContributionReward.updateOne(
          { _id: rewardDoc._id },
          { $set: { status: 'emailed', emailedAt: new Date(), lastError: '' } }
        );
        return { ok: true, code: rewardDoc.promoCode, resent: true };
      } catch (mailErr) {
        const msg = mailErr?.message || String(mailErr);
        log('warn', '[contrib-reward] resend mail failed', { userId: String(userId), milestone, error: msg });
        await ContributionReward.updateOne(
          { _id: rewardDoc._id },
          { $set: { lastError: `mail: ${msg}` } }
        );
        return { skipped: true, reason: 'mail_failed' };
      }
    }

    // Reserve a stable code before calling Stripe so we can safely retry with idempotency.
    let reservedCode = String(rewardDoc.promoCode || '').trim();
    if (!reservedCode) {
      reservedCode = buildPromoCode({ milestone });
      await ContributionReward.updateOne(
        { _id: rewardDoc._id },
        { $set: { promoCode: reservedCode, stripeCustomerId } }
      );
    }

    const promo = await createOneTimeTeamPromoCode({
      stripe,
      stripeCustomerId,
      userId,
      milestone,
      code: reservedCode,
      idempotencyKey: `contrib_reward_${String(rewardDoc._id)}`,
    });

    await ContributionReward.updateOne(
      { _id: rewardDoc._id },
      {
        $set: {
          stripeCouponId: promo.couponId,
          stripePromotionCodeId: promo.promotionCodeId,
          promoCode: promo.code || reservedCode,
          expiresAt: promo.expiresAt,
          status: 'issued',
          lastError: '',
        },
      }
    );

    const subject = 'Thank you — your 100% Team discount code';
    const html = mailTemplates.contributionRewardEmail(
      {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        milestone,
        code: promo.code,
        expiresAt: promo.expiresAt,
      },
      tenantDoc?.name || undefined
    );

    try {
      await mailService.sendMail({ to: user.email, subject, html });
      await ContributionReward.updateOne(
        { _id: rewardDoc._id },
        { $set: { status: 'emailed', emailedAt: new Date() } }
      );
    } catch (mailErr) {
      const msg = mailErr?.message || String(mailErr);
      log('warn', '[contrib-reward] mail failed', { userId: String(userId), milestone, error: msg });
      await ContributionReward.updateOne(
        { _id: rewardDoc._id },
        { $set: { lastError: `mail: ${msg}` } }
      );
      // Keep status 'issued' so it can be retried manually later if needed
    }

    return { ok: true, code: promo.code };
  } catch (e) {
    const msg = e?.message || String(e);
    await ContributionReward.updateOne(
      { _id: rewardDoc._id },
      { $set: { status: 'failed', lastError: msg } }
    );
    throw e;
  }
}

async function issueManualRewardForUser({ userId, forceResendEmail = false }) {
  if (!userId) return { skipped: true, reason: 'missing_userId' };
  const stepRaw = systemSettings.getNumber('CONTRIBUTION_REWARD_STEP');
  const step = Number.isInteger(stepRaw) && stepRaw > 0 ? stepRaw : 20;
  const total = await Certificate.countDocuments({ createdBy: userId });
  const achieved = Math.floor(Math.max(0, total) / step) * step;
  const targetMilestone = achieved >= step ? achieved : step;
  const result = await issueMilestoneReward({ userId, milestone: targetMilestone, forceResendEmail });
  return { ok: true, total, achieved, targetMilestone, step, result };
}

async function onCertificatesAdded({ userId, added = 1 }) {
  try {
    if (!userId) return { skipped: true, reason: 'missing_userId' };
    const delta = Number(added);
    if (!Number.isInteger(delta) || delta <= 0) return { skipped: true, reason: 'invalid_added' };

    const enabled = systemSettings.getBoolean('CONTRIBUTION_REWARD_AUTO_ENABLED');
    if (enabled === false) return { skipped: true, reason: 'auto_disabled' };

    const stepRaw = systemSettings.getNumber('CONTRIBUTION_REWARD_STEP');
    const step = Number.isInteger(stepRaw) && stepRaw > 0 ? stepRaw : 20;

    const total = await Certificate.countDocuments({ createdBy: userId });
    const previous = Math.max(0, total - delta);

    const milestones = [];
    for (let m = Math.floor(previous / step) * step + step; m <= total; m += step) {
      milestones.push(m);
    }
    if (!milestones.length) return { ok: true, milestones: [] };

    const issued = [];
    for (const milestone of milestones) {
      try {
        const res = await issueMilestoneReward({ userId, milestone });
        if (res && res.ok) issued.push({ milestone, code: res.code });
      } catch (e) {
        log('warn', '[contrib-reward] issue failed', { userId: String(userId), milestone, error: e?.message || String(e) });
      }
    }

    return { ok: true, step, milestones, issued };
  } catch (e) {
    log('warn', '[contrib-reward] onCertificatesAdded failed', { userId: String(userId || ''), error: e?.message || String(e) });
    return { skipped: true, reason: 'error' };
  }
}

module.exports = {
  onCertificatesAdded,
  issueManualRewardForUser,
};
