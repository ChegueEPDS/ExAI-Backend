// services/stripeContributionDiscountService.js
const crypto = require('crypto');

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function randomCodeSegment(len = 8) {
  // A-Z0-9 only (email/UX safe)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit ambiguous chars
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function buildPromoCode({ milestone }) {
  const prefix = (process.env.STRIPE_CONTRIB_PROMO_PREFIX || 'THANKS-TEAM').trim().toUpperCase();
  return `${prefix}-${Number(milestone) || 0}-${randomCodeSegment(8)}`;
}

async function resolveTeamProductId({ stripe }) {
  const override = (process.env.STRIPE_CONTRIB_TEAM_PRODUCT_ID || '').trim();
  if (override) return override;

  const priceId =
    (process.env.STRIPE_PRICE_TEAM || '').trim() ||
    (process.env.STRIPE_PRICE_TEAM_YEARLY || '').trim();

  if (!priceId) return null;
  const price = await stripe.prices.retrieve(priceId);
  return price?.product ? String(price.product) : null;
}

async function ensureCoupon({ stripe }) {
  const couponId = (process.env.STRIPE_CONTRIB_COUPON_ID || 'cert-contrib-team-1m-100').trim();
  if (!couponId) throw new Error('Missing STRIPE_CONTRIB_COUPON_ID');

  try {
    const existing = await stripe.coupons.retrieve(couponId);
    if (existing && !existing.deleted) return { couponId };
  } catch (e) {
    // 404 -> create below; other errors should bubble
    if (!String(e?.statusCode || e?.status || '').includes('404') && !/No such coupon/i.test(String(e?.message || ''))) {
      throw e;
    }
  }

  const teamProductId = await resolveTeamProductId({ stripe });
  // Safety: never create a global 100% coupon by accident.
  if (!teamProductId) {
    throw new Error('Missing STRIPE_CONTRIB_TEAM_PRODUCT_ID (and could not resolve from STRIPE_PRICE_TEAM/STRIPE_PRICE_TEAM_YEARLY)');
  }
  const createPayload = {
    id: couponId,
    name: process.env.STRIPE_CONTRIB_COUPON_NAME || 'Certificate contribution reward (Team)',
    percent_off: toInt(process.env.STRIPE_CONTRIB_PERCENT_OFF, 100),
    duration: 'repeating',
    duration_in_months: toInt(process.env.STRIPE_CONTRIB_DURATION_MONTHS, 1),
    metadata: { source: 'certificate-contribution' },
  };

  createPayload.applies_to = { products: [teamProductId] };

  await stripe.coupons.create(createPayload);
  return { couponId };
}

async function createOneTimeTeamPromoCode({ stripe, stripeCustomerId, userId, milestone, code, idempotencyKey }) {
  if (!stripeCustomerId) throw new Error('Missing stripeCustomerId');

  const { couponId } = await ensureCoupon({ stripe });
  const maxRedemptions = toInt(process.env.STRIPE_CONTRIB_MAX_REDEMPTIONS, 1);
  const ttlDays = toInt(process.env.STRIPE_CONTRIB_PROMO_TTL_DAYS, 60);
  const expiresAt = ttlDays > 0 ? nowUnix() + ttlDays * 24 * 60 * 60 : null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const finalCode = code || buildPromoCode({ milestone });
    try {
      const promo = await stripe.promotionCodes.create(
        {
          promotion: { type: 'coupon', coupon: couponId },
          code: finalCode,
          max_redemptions: maxRedemptions,
          customer: stripeCustomerId,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          metadata: {
            source: 'certificate-contribution',
            userId: userId ? String(userId) : '',
            milestone: String(milestone || ''),
          },
        },
        idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : undefined
      );
      return {
        couponId,
        promotionCodeId: promo?.id ? String(promo.id) : null,
        code: finalCode,
        expiresAt: expiresAt ? new Date(expiresAt * 1000) : null,
      };
    } catch (e) {
      // Retry only on code collisions
      const msg = String(e?.message || '');
      if (/already exists/i.test(msg) || /must be unique/i.test(msg) || /promotion code.*exists/i.test(msg)) continue;
      throw e;
    }
  }

  throw new Error('Failed to create unique promotion code after retries');
}

module.exports = {
  ensureCoupon,
  createOneTimeTeamPromoCode,
  buildPromoCode,
};
