// controllers/billingController.js
const Stripe = require('stripe');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const ContributionReward = require('../models/contributionReward');

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (stripeKey) {
    stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
}

const { ensureStripeCustomerForTenant } = require('../services/stripeCustomerProvisioning');
const brevoService = require('../services/brevoService');

// Env-driven toggle for phone collection in Checkout (default: false)
const COLLECT_PHONE = String(process.env.STRIPE_CHECKOUT_COLLECT_PHONE || 'false').toLowerCase() === 'true';

// kis helper, hogy endpoint elején ellenőrizzünk
function requireStripeOrFail(res) {
    if (!stripe) {
        res.status(501).json({ message: 'Stripe is not configured on this server' });
        return false;
    }
    return true;
}
// Ensure absolute URLs (fallback to localhost dev urls)
function ensureAbsUrl(input, fallback) {
  try {
    if (!input || typeof input !== 'string') throw new Error('empty');
    const u = new URL(input.trim());
    return u.toString();
  } catch (_) {
    return fallback;
  }
}

// --- Portal state + fresh access token helpers ---
function signPortalState(payload, expires = '10m') {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET');
  return jwt.sign(payload, secret, { expiresIn: expires });
}
function verifyPortalState(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET');
  return jwt.verify(token, secret);
}
async function issueAccessTokenForUserTenant(userId, tenantId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET');
  const user = await User.findById(userId).lean();
  const tenant = await Tenant.findById(tenantId).lean();
  if (!user || !tenant) throw new Error('User or Tenant not found');

  // subscription snapshot (if any)
  const sub = await Subscription.findOne({ tenantId: tenant._id }).lean();
  const tier = (sub?.tier || tenant.plan || 'free').toString().toLowerCase();
  const status = (sub?.status || (tier === 'free' ? 'none' : 'active')).toString().toLowerCase();
  const seatsPurchased = Number.isFinite(Number(sub?.seatsPurchased)) ? Number(sub.seatsPurchased) : (tier === 'team' ? (tenant.seats?.max || 5) : 1);
  const flags = {
    isFree: tier === 'free',
    isPro: tier === 'pro',
    isTeam: tier === 'team'
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 60 * 60; // 1h

  const payload = {
    sub: String(user._id),
    userId: String(user._id),
    role: user.role || 'User',
    tenantId: String(tenant._id),
    tenantName: tenant.name || null,
    tenantType: tenant.type || null,
    nickname: user.nickname || null,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    azureId: user.azureId || null,
    subscription: {
      tenantName: tenant.name || null,
      tenantType: tenant.type || null,
      plan: tier,
      seats: { max: tenant.seats?.max ?? (tier === 'team' ? 5 : 1), used: tenant.seats?.used ?? 1 },
      seatsManaged: tenant.seatsManaged || 'stripe',
      tier,
      status,
      seatsPurchased,
      lastUpdate: new Date().toISOString(),
      flags
    },
    type: 'access',
    v: 2,
    iat: nowSec,
    exp: expSec
  };

  return jwt.sign(payload, secret);
}

// Resolve Stripe Customer ID for a tenant:
// 1) Try Tenant.stripeCustomerId
// 2) Fallback to Subscription.stripeCustomerId (by tenantId)
//    If found, cache it back to Tenant for future calls.
async function resolveStripeCustomerId(tenantId) {
  if (!tenantId) return null;
  // Try from Tenant
  let tenantDoc = await Tenant.findById(tenantId);
  if (tenantDoc?.stripeCustomerId) {
    return tenantDoc.stripeCustomerId;
  }
  // Fallback: Subscription by tenantId
  const sub = await Subscription.findOne({ tenantId }).lean();
  const fromSub = sub?.stripeCustomerId || null;
  if (fromSub && tenantDoc) {
    try {
      tenantDoc.stripeCustomerId = fromSub;
      await tenantDoc.save();
    } catch {}
  }
  return fromSub;
}
// POST /api/billing/checkout
// Body (normalizált a route middleware által): 
//   { tenantId: string, plan: 'pro'|'team', seats: number, priceId?, successUrl?, cancelUrl?, companyName?, userId? }
// - For TEAM flow, companyName and userId are optional and used for customer and metadata.
exports.createCheckoutSession = async (req, res) => {
    if (!requireStripeOrFail(res)) return;

    try {
        const { tenantId, plan, seats, priceId, successUrl, cancelUrl, companyName, userId } = req.body;
        console.log('[billing] /checkout body:', JSON.stringify({
            tenantId,
            plan,
            seats,
            priceId,
            successUrl,
            cancelUrl,
            companyName,
            userId
        }, null, 2));

        // --- Support monthly + yearly variants; keep legacy behavior otherwise ---
        // Frontend küldi: plan (pl. "pro" | "team" | "pro_yearly" | "team_yearly")
        // + product ("pro"|"team") + billingPeriod ("month"|"year").
        // A normalizedPlan-t mindig ezek alapján határozzuk meg, de kompatibilisek maradunk a régi hívásokkal.

        // Nyers értékek a body-ból
        const rawPlan = (plan || '').toString().toLowerCase();
        const rawProduct = (req.body.product || '').toString().toLowerCase();
        const rawPeriod = (req.body.billingPeriod || '').toString().toLowerCase();

        // Termék: pro vagy team (alapértelmezés: pro)
        const product = rawProduct === 'team' ? 'team' : 'pro';
        // Periódus: month vagy year (alapértelmezés: month, ha nincs megadva)
        const period = rawPeriod === 'year' ? 'year' : 'month';

        // Támogatott plan stringek
        const allowedPlans = ['pro', 'team', 'pro_yearly', 'team_yearly'];

        // Ha a rawPlan már egy ismert string, használjuk azt, különben derive product+period alapján.
        let normalizedPlan = rawPlan;
        if (!allowedPlans.includes(normalizedPlan)) {
            if (product === 'team') {
                normalizedPlan = period === 'year' ? 'team_yearly' : 'team';
            } else {
                normalizedPlan = period === 'year' ? 'pro_yearly' : 'pro';
            }
        }

        const isTeam = normalizedPlan === 'team' || normalizedPlan === 'team_yearly';
        const isPro = normalizedPlan === 'pro' || normalizedPlan === 'pro_yearly';
        const isYearly = normalizedPlan === 'pro_yearly' || normalizedPlan === 'team_yearly';

        // Base plan és billing period a Stripe metadatához
        const basePlan = isTeam ? 'team' : 'pro';
        const billingPeriod = isYearly ? 'year' : 'month';

        // Debug: plan flags and billing period
        console.log('[billing] normalized plan flags:', JSON.stringify({
            rawPlan,
            rawProduct,
            rawPeriod,
            product,
            period,
            normalizedPlan,
            isTeam,
            isPro,
            isYearly,
            basePlan,
            billingPeriod
        }, null, 2));

        // Quantity: TEAM → min 5, PRO → always 1
        const qty = isTeam ? Math.max(5, Number(seats) || 5) : 1;

        // Price selection: explicit priceId overrides everything; otherwise env mapping
        const PRICE_BY_PLAN = {
            pro:          process.env.STRIPE_PRICE_PRO,                                        // monthly PRO
            team:         process.env.STRIPE_PRICE_TEAM,                                       // monthly TEAM
            pro_yearly:   process.env.STRIPE_PRICE_PRO_YEARLY, 
            team_yearly:  process.env.STRIPE_PRICE_TEAM_YEARLY || process.env.STRIPE_PRICE_TEAM,
        };
        console.log('[billing] PRICE_BY_PLAN mapping:', JSON.stringify({
            STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
            STRIPE_PRICE_TEAM: process.env.STRIPE_PRICE_TEAM,
            STRIPE_PRICE_PRO_YEARLY: process.env.STRIPE_PRICE_PRO_YEARLY,
            STRIPE_PRICE_TEAM_YEARLY: process.env.STRIPE_PRICE_TEAM_YEARLY
        }, null, 2));
        const chosenPriceId = priceId || PRICE_BY_PLAN[normalizedPlan];
        console.log('[billing] chosen price:', JSON.stringify({
            normalizedPlan,
            explicitPriceId: priceId || null,
            chosenPriceId,
            qty,
        }, null, 2));
        if (!chosenPriceId) {
            return res.status(500).json({ message: `Stripe price is not configured for plan "${normalizedPlan}".` });
        }

        // Success / Cancel URL fallback and normalization
        const RAW_SUCCESS = successUrl || process.env.BILLING_SUCCESS_URL || 'http://localhost:4200/billing/success';
        const RAW_CANCEL  = cancelUrl  || process.env.BILLING_CANCEL_URL  || 'http://localhost:4200/billing/cancel';
        const SUCCESS_URL = ensureAbsUrl(RAW_SUCCESS, 'http://localhost:4200/billing/success');
        const CANCEL_URL  = ensureAbsUrl(RAW_CANCEL,  'http://localhost:4200/billing/cancel');

        // Branch by plan
        if (normalizedPlan === 'pro' || normalizedPlan === 'pro_yearly') {
            // Require tenantId for pro plan
            if (!tenantId) {
                return res.status(400).json({ message: 'tenantId is required for pro plan' });
            }
            // Tenant ellenőrzés + (ha kell) Stripe customer létrehozás
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            let customerId = tenant.stripeCustomerId;
            if (!customerId) {
                customerId = await ensureStripeCustomerForTenant({
                  stripe,
                  tenantDoc: tenant,
                  user: req.user || null
                });
            }

            console.log('[billing] creating PRO checkout session with:', JSON.stringify({
                mode: 'subscription',
                customerId,
                price: chosenPriceId,
                qty,
                basePlan,
                billingPeriod,
                metadataPlan: normalizedPlan
            }, null, 2));
            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer: customerId,
                line_items: [{
                    price: chosenPriceId,
                    quantity: qty,
                }],
                // Collect full billing details & tax IDs in Checkout
                billing_address_collection: 'required',
                tax_id_collection: { enabled: true },
                // Optional: collect phone number (env-controlled)
                phone_number_collection: { enabled: COLLECT_PHONE },
                // Enable Stripe Tax (if configured on Dashboard)
                automatic_tax: { enabled: true },
                // Copy name & address from Checkout to the Customer automatically
                customer_update: { address: 'auto', name: 'auto' },
                allow_promotion_codes: true,
                client_reference_id: String(tenant._id),
                success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
                cancel_url: CANCEL_URL,
                subscription_data: {
                    metadata: {
                        plan: normalizedPlan,
                        basePlan,
                        billingPeriod,
                        seats: String(qty),
                        tenantId: String(tenant._id),
                        userId: (req.user?.id || req.user?._id || userId || '').toString()
                    }
                },
                metadata: {
                    plan: normalizedPlan,
                    basePlan,
                    billingPeriod,
                    seats: String(qty),
                    tenantId: String(tenant._id),
                    userId: (req.user?.id || req.user?._id || userId || '').toString()
                }
            });

            return res.json({ url: session.url });
        } else if (normalizedPlan === 'team' || normalizedPlan === 'team_yearly') {
            const allowPromoCodes = normalizedPlan !== 'team_yearly'; // reward codes are meant for monthly only
            if (!tenantId) {
                // TEAM: free-first flow (no tenant yet)
                // Prefer re-using the user's existing Stripe customer (so customer-restricted promo codes work).
                let customerId = null;
                let shouldBrevoSync = false;
                try {
                  const fallbackTenantId = req.user?.tenantId || req.scope?.tenantId || null;
                  if (fallbackTenantId) {
                    const t = await Tenant.findById(fallbackTenantId);
                    if (t) {
                      customerId = t.stripeCustomerId;
                      if (!customerId) {
                        customerId = await ensureStripeCustomerForTenant({
                          stripe,
                          tenantDoc: t,
                          user: req.user || null
                        });
                        shouldBrevoSync = !!customerId;
                      }
                    }
                  }
                } catch (_) {}

                if (!customerId) {
                  const newCustomer = await stripe.customers.create({
                      name: (companyName || 'Company').toString(),
                      email: req.user?.email || undefined,
                      metadata: {
                          intent: 'team',
                          userId: (req.user?.id || req.user?._id || userId || '').toString(),
                          companyName: (companyName || '').toString()
                      }
                  });
                  customerId = newCustomer.id;
                  shouldBrevoSync = true;
                }

                if (shouldBrevoSync) {
                  // Fire-and-forget Brevo sync on Stripe customer creation (no tenant yet)
                  brevoService.onStripeCustomerCreated({
                    email: req.user?.email || null,
                    firstName: req.user?.firstName || '',
                    lastName: req.user?.lastName || '',
                    stripeCustomerId: customerId,
                    tenant: { name: (companyName || '').toString(), plan: 'team', type: 'company' },
                  });
                }
                const clientRef = `team|${(req.user?.id || req.user?._id || userId || '').toString()}`;
                const meta = {
                    intent: 'team',
                    plan: normalizedPlan,
                    basePlan,
                    billingPeriod,
                    seats: String(qty),
                    userId: (req.user?.id || req.user?._id || userId || '').toString(),
                    companyName: (companyName || '').toString()
                };
                console.log('[billing] creating TEAM checkout session (no tenantId) with:', JSON.stringify({
                    mode: 'subscription',
                    customerId,
                    price: chosenPriceId,
                    qty,
                    basePlan,
                    billingPeriod,
                    metadataPlan: normalizedPlan,
                    meta
                }, null, 2));
                const session = await stripe.checkout.sessions.create({
                    mode: 'subscription',
                    customer: customerId,
                    line_items: [{
                        price: chosenPriceId,
                        quantity: qty,
                    }],
                    // Collect full billing details & tax IDs in Checkout
                    billing_address_collection: 'required',
                    tax_id_collection: { enabled: true },
                    // Optional: collect phone number (env-controlled)
                    phone_number_collection: { enabled: COLLECT_PHONE },
                    // Enable Stripe Tax (if configured on Dashboard)
                    automatic_tax: { enabled: true },
                    // Copy name & address from Checkout to the Customer automatically
                    customer_update: { address: 'auto', name: 'auto' },
                    allow_promotion_codes: allowPromoCodes,
                    client_reference_id: clientRef,
                    success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
                    cancel_url: CANCEL_URL,
                    subscription_data: {
                        metadata: meta
                    },
                    metadata: meta
                });
                return res.json({ url: session.url });
            } else {
                // TEAM: admin/edge case with tenantId
                const tenant = await Tenant.findById(tenantId);
                if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

                let customerId = tenant.stripeCustomerId;
                if (!customerId) {
                    customerId = await ensureStripeCustomerForTenant({
                      stripe,
                      tenantDoc: tenant,
                      user: req.user || null
                    });
                }
                const meta = {
                    plan: normalizedPlan,
                    basePlan,
                    billingPeriod,
                    seats: String(qty),
                    tenantId: String(tenant._id),
                    userId: (req.user?.id || req.user?._id || userId || '').toString(),
                    companyName: (companyName || '').toString()
                };
                console.log('[billing] creating TEAM checkout session (with tenantId) with:', JSON.stringify({
                    mode: 'subscription',
                    customerId,
                    price: chosenPriceId,
                    qty,
                    basePlan,
                    billingPeriod,
                    metadataPlan: normalizedPlan,
                    meta
                }, null, 2));
                const session = await stripe.checkout.sessions.create({
                    mode: 'subscription',
                    customer: customerId,
                    line_items: [{
                        price: chosenPriceId,
                        quantity: qty,
                    }],
                    // Collect full billing details & tax IDs in Checkout
                    billing_address_collection: 'required',
                    tax_id_collection: { enabled: true },
                    // Optional: collect phone number (env-controlled)
                    phone_number_collection: { enabled: COLLECT_PHONE },
                    // Enable Stripe Tax (if configured on Dashboard)
                    automatic_tax: { enabled: true },
                    // Copy name & address from Checkout to the Customer automatically
                    customer_update: { address: 'auto', name: 'auto' },
                    allow_promotion_codes: allowPromoCodes,
                    client_reference_id: String(tenant._id),
                    success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
                    cancel_url: CANCEL_URL,
                    subscription_data: {
                        metadata: meta
                    },
                    metadata: meta
                });
                return res.json({ url: session.url });
            }
        } else {
            return res.status(400).json({ message: 'Unknown plan' });
        }
    } catch (e) {
        console.error('[billing] createCheckoutSession error', e);
        return res.status(500).json({ message: e.message });
    }
};


// POST /api/billing/portal
// body: { tenantId?, returnUrl? }
// - tenantId optional: falls back to req.scope.tenantId or req.user.tenantId
// - returnUrl optional: validated to absolute URL; falls back to env or local /account
exports.createBillingPortal = async (req, res) => {
  if (!requireStripeOrFail(res)) return;
  try {
    const { tenantId, returnUrl } = req.body || {};
    // Resolve tenantId from body or auth scope
    const resolvedTenantId =
      tenantId ||
      req.scope?.tenantId ||
      req.user?.tenantId ||
      null;

    if (!resolvedTenantId) {
      return res.status(400).json({ message: 'Missing tenantId' });
    }

    // Resolve Stripe customer id from Tenant or Subscription snapshot (and cache it back to Tenant if needed)
    const customerId = await resolveStripeCustomerId(resolvedTenantId);
    if (!customerId) {
      return res.status(400).json({ message: 'No stripeCustomerId' });
    }

    // Determine desired frontend return path (default: /account)
    let toPath = '/account';
    if (req.body && typeof req.body.returnUrl === 'string') {
      try {
        // if absolute, take only the path part; if relative, use as-is
        const maybe = req.body.returnUrl.trim();
        if (maybe.startsWith('http://') || maybe.startsWith('https://')) {
          const u = new URL(maybe);
          toPath = u.pathname + (u.search || '');
        } else if (maybe.startsWith('/')) {
          toPath = maybe;
        }
      } catch (_) {}
    }
    const apiBase = process.env.BASE_URL || 'http://localhost:3000';
    const callerUserId =
      (req.scope?.userId && String(req.scope.userId)) ||
      (req.user?.id && String(req.user.id)) ||
      (req.user?._id && String(req.user._id)) ||
      null;

    const stateJwt = signPortalState({
      userId: callerUserId,
      tenantId: String(resolvedTenantId),
      to: toPath
    }, '10m');
    const returnToApi = `${apiBase.replace(/\/+$/,'')}/api/billing/portal/return?state=${encodeURIComponent(stateJwt)}`;

    // Create Billing Portal session
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnToApi
    });

    return res.json({ url: portal.url });
  } catch (e) {
    console.error('[billing] createBillingPortal error', e);
    return res.status(500).json({ message: e.message });
  }
};

// POST /api/billing/free-next-invoice
// body: { tenantId, couponId }  // 100% OFF, duration: 'once' kupon
exports.applyFreeNextInvoice = async (req, res) => {
    if (!requireStripeOrFail(res)) return;
    try {
        const { tenantId, couponId } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant?.stripeSubscriptionId) {
            return res.status(400).json({ message: 'No active subscription to apply coupon' });
        }

        await stripe.subscriptions.update(tenant.stripeSubscriptionId, { coupon: couponId });
        res.json({ message: '✅ Next invoice will be 0 (coupon applied).' });
    } catch (e) {
        console.error('[billing] applyFreeNextInvoice error', e);
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /api/billing/update-quantity
 * Body: { tenantId, quantity, priceLookupKey?, productId? }
 * - seatsManaged: 'stripe' esetén a Stripe subscription item quantity frissítése
 * - proration_behavior: 'none' → a változás a következő ciklustól érvényes
 */
exports.updateQuantity = async (req, res) => {
    if (!requireStripeOrFail(res)) return;
    try {
        const { tenantId, quantity, priceLookupKey, productId } = req.body;
        const q = Number(quantity);
        if (!tenantId || !Number.isInteger(q) || q < 1) {
            return res.status(400).json({ message: 'Invalid tenantId or quantity' });
        }

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (tenant.seatsManaged !== 'stripe') {
            return res.status(400).json({ message: 'Seats are managed manually for this tenant' });
        }
        if (!tenant.stripeSubscriptionId) {
            return res.status(400).json({ message: 'No stripeSubscriptionId on tenant' });
        }

        // 1) Stripe subscription betöltése
        const sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
        const items = sub.items?.data || [];
        if (!items.length) return res.status(400).json({ message: 'No subscription items found' });

        // 2) Megfelelő item kiválasztása (lookup_key vagy product alapján, különben az első)
        let targetItem = null;
        if (priceLookupKey) {
            targetItem = items.find(it => it.price?.lookup_key === priceLookupKey) || null;
        }
        if (!targetItem && productId) {
            targetItem = items.find(it => it.price?.product === productId) || null;
        }
        if (!targetItem) {
            targetItem = items[0];
        }

        // 3) Mennyiség frissítése proration nélkül
        const updated = await stripe.subscriptions.update(sub.id, {
            items: [{ id: targetItem.id, quantity: q }],
            proration_behavior: 'none'
        });

        // 4) (Opció) azonnali helyi update az UI konzisztenciához (webhook is frissít majd)
        tenant.seats.max = q;
        await tenant.save();
        await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            { seatsPurchased: q, status: updated.status },
            { upsert: true }
        );

        return res.json({
            message: 'Quantity updated',
            seats: { max: q, used: tenant.seats.used },
            stripeStatus: updated.status
        });
    } catch (e) {
        console.error('[billing] updateQuantity error', e);
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /api/billing/grant-credit
 * Body: { tenantId, amount, currency? }
 * - Ügyfél egyenleg jóváírása (pozitív amount → jóváírás)
 * - A következő számlából automatikusan levonódik a Stripe-ban.
 */
exports.grantCredit = async (req, res) => {
    if (!requireStripeOrFail(res)) return;
    try {
        const { tenantId, amount, currency } = req.body;
        const amt = Number(amount);
        const cur = String(currency || 'HUF').toUpperCase();

        if (!tenantId || !Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ message: 'Invalid tenantId or amount' });
        }

        const tenant = await Tenant.findById(tenantId);
        if (!tenant?.stripeCustomerId) {
            return res.status(400).json({ message: 'No stripeCustomerId on tenant' });
        }

        await stripe.customers.createBalanceTransaction(tenant.stripeCustomerId, {
            amount: Math.round(amt * 100),  // minor unit (HUF/EUR cent stb.)
            currency: cur,
            description: 'Admin credit (goodwill / promo)',
        });

        res.json({ message: `✅ Credit granted: ${amt} ${cur}` });
    } catch (e) {
        console.error('[billing] grantCredit error', e);
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /api/billing/pause
 * Body: { tenantId, behavior? }  // 'keep_as_draft' | 'mark_uncollectible' | 'void'
 * - A számlázás szüneteltetése; a Stripe nem számláz addig, amíg resume nincs.
 */
exports.pauseSubscription = async (req, res) => {
    if (!requireStripeOrFail(res)) return;
    try {
        const { tenantId, behavior = 'keep_as_draft' } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant?.stripeSubscriptionId) {
            return res.status(400).json({ message: 'No stripeSubscriptionId on tenant' });
        }

        const updated = await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
            pause_collection: { behavior } // keep_as_draft | mark_uncollectible | void
        });

        res.json({
            message: 'Subscription paused',
            status: updated.status,
            pause_collection: updated.pause_collection
        });
    } catch (e) {
        console.error('[billing] pauseSubscription error', e);
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /api/billing/resume
 * Body: { tenantId }
 * - A szüneteltetés feloldása; a számlázás a következő ciklustól folytatódik (Stripe logikától függően).
 */
exports.resumeSubscription = async (req, res) => {
    if (!requireStripeOrFail(res)) return;
    try {
        const { tenantId } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant?.stripeSubscriptionId) {
            return res.status(400).json({ message: 'No stripeSubscriptionId on tenant' });
        }

        const updated = await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
            pause_collection: ''
        });

        res.json({
            message: 'Subscription resumed',
            status: updated.status,
            pause_collection: updated.pause_collection
        });
    } catch (e) {
        console.error('[billing] resumeSubscription error', e);
        res.status(500).json({ message: e.message });
    }
};

// GET /api/billing/contribution-reward/redeem?token=...
// Public endpoint (no auth) protected by a short-lived signed token sent in email.
exports.redeemContributionReward = async (req, res) => {
  if (!requireStripeOrFail(res)) return;
  try {
    const token = String(req.query?.token || '').trim();
    if (!token) return res.status(400).send('Missing token');

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(400).send('Invalid or expired token');
    }

    if (decoded?.type !== 'contrib_reward_redeem') {
      return res.status(400).send('Invalid token type');
    }

    const rewardId = decoded.rewardId;
    const userId = decoded.userId;
    if (!rewardId || !userId) return res.status(400).send('Invalid token payload');

    const reward = await ContributionReward.findById(rewardId).lean();
    if (!reward) return res.status(404).send('Reward not found');
    if (String(reward.userId || '') !== String(userId)) return res.status(403).send('Forbidden');
    if (!reward.stripeCustomerId || !reward.stripeCouponId) return res.status(400).send('Reward is not ready');
    if (!reward.stripePromotionCodeId) return res.status(400).send('Promotion code is missing');
    if (reward.expiresAt && new Date(reward.expiresAt) < new Date()) return res.status(410).send('Reward expired');

    const tenant = reward.tenantId ? await Tenant.findById(reward.tenantId) : null;
    const buyer = await User.findById(userId).select('email').lean();
    const emailLocal = buyer?.email && String(buyer.email).includes('@') ? String(buyer.email).split('@')[0] : '';
    const companyNameGuessRaw =
      (tenant?.type === 'company' && tenant?.name ? String(tenant.name) : '') ||
      (tenant?.name ? String(tenant.name) : '') ||
      emailLocal ||
      'company';
    const companyNameGuess = companyNameGuessRaw.replace(/^u-+/i, '').trim() || 'company';
    const portalBase = (tenant?.name || '').toLowerCase() === 'index' ? 'https://exai.ind-ex.ae' : 'https://certs.atexdb.eu';
    const successUrl = ensureAbsUrl(process.env.BILLING_SUCCESS_URL || `${portalBase}/billing/success`, `${portalBase}/billing/success`);
    const cancelUrl = ensureAbsUrl(process.env.BILLING_CANCEL_URL || `${portalBase}/billing`, `${portalBase}/billing`);

    // If there is an existing subscription, apply coupon to it and redirect to Billing Portal
    const subId = tenant?.stripeSubscriptionId || null;
    if (subId) {
      try {
        await stripe.subscriptions.update(subId, { coupon: String(reward.stripeCouponId) });
      } catch (e) {
        console.warn('[reward] failed to apply coupon to subscription:', e?.message || e);
      }

      const portal = await stripe.billingPortal.sessions.create({
        customer: String(reward.stripeCustomerId),
        return_url: `${portalBase}/account`,
      });
      return res.redirect(303, portal.url);
    }

    // Otherwise create a Team monthly checkout with the promotion code pre-applied
    const priceId = String(process.env.STRIPE_PRICE_TEAM || '').trim();
    if (!priceId) return res.status(500).send('Missing STRIPE_PRICE_TEAM');

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: String(reward.stripeCustomerId),
      line_items: [{ price: priceId, quantity: 5 }],
      discounts: [{ promotion_code: String(reward.stripePromotionCodeId) }],
      // keep the flow strict: we pre-apply the promo code
      allow_promotion_codes: false,
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      phone_number_collection: { enabled: COLLECT_PHONE },
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        source: 'certificate-contribution',
        rewardId: String(reward._id),
        userId: String(userId),
        companyName: companyNameGuess,
        plan: 'team',
        billingPeriod: 'month',
      },
      subscription_data: {
        metadata: {
          source: 'certificate-contribution',
          rewardId: String(reward._id),
          userId: String(userId),
          companyName: companyNameGuess,
          plan: 'team',
          billingPeriod: 'month',
        },
      },
    });

    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[reward] redeemContributionReward error', e);
    return res.status(500).send('Failed to redeem reward');
  }
};

// GET /api/billing/contribution-reward/copy?code=...
// Minimal helper page to copy code to clipboard (email clients can't run JS, browsers can).
exports.copyContributionRewardCodePage = async (req, res) => {
  try {
    const code = String(req.query?.code || '').trim();
    if (!code) return res.status(400).send('Missing code');
    const safe = code.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Copy promotion code</title>
  <style>
    body{font-family:Arial, sans-serif; background:#f5f6f8; margin:0; padding:24px;}
    .card{max-width:520px; margin:0 auto; background:#fff; border-radius:10px; padding:20px; box-shadow:0 6px 24px rgba(0,0,0,.08);}
    .code{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:18px; background:#ebebeb; padding:12px 14px; border-radius:8px; word-break:break-all; text-align:center;}
    button{background:#f8d201; color:#131313; border:0; padding:12px 16px; border-radius:8px; font-size:16px; width:100%; cursor:pointer;}
    .muted{color:#666; font-size:13px; margin-top:10px;}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 12px 0; color:#131313;">Promotion code</h2>
    <div id="code" class="code">${safe}</div>
    <p style="margin:14px 0 10px 0;">
      <button id="copyBtn" type="button">Copy to clipboard</button>
    </p>
    <div id="status" class="muted"></div>
    <div class="muted">If copying is blocked, select the code and copy manually.</div>
  </div>
  <script>
    const code = ${JSON.stringify(code)};
    const status = document.getElementById('status');
    async function doCopy() {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(code);
          status.textContent = 'Copied.';
          return;
        }
      } catch {}
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('code'));
        sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('copy');
        status.textContent = 'Copied.';
      } catch {
        status.textContent = 'Copy failed.';
      }
    }
    document.getElementById('copyBtn').addEventListener('click', doCopy);
    // Try once on load (best-effort)
    doCopy();
  </script>
</body>
</html>`);
  } catch (e) {
    return res.status(500).send('Failed');
  }
};

/**
 * POST /api/billing/grant-manual-license
 * Body: { tenantId, tier: 'pro'|'team', seats?, months?, days?, until? }
 * - DB-only licenc adása Stripe nélkül
 * - Átállítja: tenant.seatsManaged='manual', tenant.plan=tier, tenant.type (team→company, pro→personal), seats.max
 * - Subscription upsert: { tier, status:'active', seatsPurchased, expiresAt }
 */
// NOTE: Manual license flow does NOT require Stripe
exports.grantManualLicense = async (req, res) => {
    try {
        const { tenantId, tier, seats, months, days, until } = req.body || {};
        if (!tenantId || !tier || !['pro', 'team'].includes(String(tier))) {
            return res.status(400).json({ message: 'tenantId and tier (pro|team) are required' });
        }
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // derive expiry
        let expiresAt = null;
        if (until) {
            const u = new Date(until);
            if (isNaN(u.getTime())) return res.status(400).json({ message: 'Invalid until date' });
            expiresAt = u;
        } else {
            const m = Number.isFinite(Number(months)) ? Number(months) : 0;
            const d = Number.isFinite(Number(days)) ? Number(days) : 0;
            if (m > 0 || d > 0) {
                const now = new Date();
                expiresAt = new Date(now.getTime());
                if (m > 0) expiresAt.setMonth(expiresAt.getMonth() + m);
                if (d > 0) expiresAt.setDate(expiresAt.getDate() + d);
            }
        }

        // enforce manual mode + plan/type
        tenant.seatsManaged = 'manual';
        tenant.plan = String(tier);
        tenant.type = (String(tier) === 'team') ? 'company' : 'personal';

        // seats
        const s = Number.isInteger(Number(seats)) && Number(seats) > 0 ? Number(seats) : (tier === 'team' ? 5 : 1);
        tenant.seats = { max: s, used: Math.min(tenant.seats?.used || 1, s) };

        await tenant.save();

        // upsert Subscription doc (DB-only)
        await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            {
                tenantId: tenant._id,
                tier: String(tier),
                status: 'active',
                seatsPurchased: s,
                expiresAt
            },
            { upsert: true, new: true }
        );

        return res.json({
            message: '✅ Manual license granted',
            tenant: {
                id: tenant._id,
                plan: tenant.plan,
                type: tenant.type,
                seats: tenant.seats,
                seatsManaged: tenant.seatsManaged
            },
            subscription: { tier: String(tier), status: 'active', seatsPurchased: s, expiresAt }
        });
    } catch (e) {
        console.error('[billing] grantManualLicense error', e);
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /api/billing/revoke-manual-license
 * Body: { tenantId, downgradeToFree? }  // if true, set plan='free', type='personal', seats.max=1
 * - Manual licenc visszavonása (Stripe nélkül)
 */
exports.revokeManualLicense = async (req, res) => {
    try {
        const { tenantId, downgradeToFree } = req.body || {};
        if (!tenantId) return res.status(400).json({ message: 'tenantId is required' });

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // Set subscription canceled
        await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            { status: 'canceled' },
            { upsert: true }
        );

        // Optionally downgrade tenant to free personal
        if (downgradeToFree) {
            tenant.plan = 'free';
            tenant.type = 'personal';
            tenant.seatsManaged = 'manual';
            tenant.seats = { max: 1, used: Math.min(tenant.seats?.used || 1, 1) };
            await tenant.save();
        }

        return res.json({ message: '✅ Manual license revoked', downgraded: !!downgradeToFree });
    } catch (e) {
        console.error('[billing] revokeManualLicense error', e);
        res.status(500).json({ message: e.message });
    }
};

// GET /api/billing/invoices
// Kilistázza a bejelentkezett felhasználó AKTUÁLIS tenantjához tartozó Stripe számlákat
exports.listInvoicesForMe = async (req, res) => {
  if (!requireStripeOrFail(res)) return;
  try {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ message: 'Missing tenantId in request scope' });
    }

    const customerId = await resolveStripeCustomerId(tenantId);
    if (!customerId) {
      // nincs Stripe ügyfél -> nincs számla
      return res.json({ invoices: [] });
    }

    // Stripe számlák lekérése
    const list = await stripe.invoices.list({
      customer: customerId,
      limit: 20
    });

    // Minimal, UI-barát adatok
    const invoices = (list?.data || []).map(inv => ({
      id: inv.id,
      number: inv.number,
      status: inv.status, // draft, open, paid, uncollectible, void
      currency: inv.currency,
      total: inv.total,   // minor units (pl. HUF/EUR cent)
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf,
      created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
      period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    }));

    return res.json({ invoices });
  } catch (e) {
    console.error('[billing] listInvoicesForMe error', e);
    return res.status(500).json({ message: 'Failed to load invoices' });
  }
};

// GET /api/billing/portal/return?state=...
// Enhanced: supports direct JWT passthrough via query, and robust redirect logic.
exports.handleBillingPortalReturn = async (req, res) => {
  try {
    const { state, jwt: jwtFromQuery, to } = req.query || {};

    // 1) Shortcut: if we already have a JWT in the query, persist it and bounce to the target.
    if (typeof jwtFromQuery === 'string' && jwtFromQuery.length > 0) {
      // Determine destination:
      // - if ?to is absolute (http/https) -> use as is
      // - if ?to starts with "/" -> prepend FRONTEND_BASE_URL
      // - else treat as relative path with query/fragment, fallback to /account
      const frontBase = (process.env.FRONTEND_BASE_URL || 'http://localhost:4200').replace(/\/+$/,'');
      let dest = `${frontBase}/account`;
      if (typeof to === 'string' && to.trim()) {
        const raw = to.trim();
        try {
          if (raw.startsWith('http://') || raw.startsWith('https://')) {
            dest = raw;
          } else if (raw.startsWith('/')) {
            dest = `${frontBase}${raw}`;
          } else {
            // treat as relative path (no leading slash)
            dest = `${frontBase}/${raw}`;
          }
        } catch (_) {
          dest = `${frontBase}/account`;
        }
      }

      // Respond with a tiny HTML that stores the token then redirects.
      res.status(200).type('html').send(`
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Updating session…</title></head>
  <body>
    <script>
      (function(){
        try { localStorage.setItem('token', ${JSON.stringify(jwtFromQuery)}); } catch(e) {}
        location.replace(${JSON.stringify(dest)});
      })();
    </script>
  </body>
</html>`);
      return;
    }

    // 2) Normal flow with signed state: verify, wait (optional), mint fresh JWT, redirect with ?jwt=
    if (!state || typeof state !== 'string') {
      return res.status(400).json({ message: 'Missing state or jwt' });
    }

    const decoded = verifyPortalState(state);
    const userId = decoded.userId;
    const tenantId = decoded.tenantId;

    let toPath = '/account';
    const pickSafePath = (val) => {
      if (typeof val !== 'string') return null;
      const s = val.trim();
      if (s.startsWith('/')) return s;           // absolute app path
      if (s && !s.startsWith('http')) return `/${s.replace(/^\/+/, '')}`; // relative -> normalize
      return null; // disallow absolute external here
    };
    toPath = pickSafePath(decoded.to) || pickSafePath(to) || '/account';

    if (!userId || !tenantId) {
      return res.status(400).json({ message: 'Invalid state' });
    }

    // Optional small wait so Stripe webhooks can sync DB first
    const waitMs = Number(process.env.PORTAL_RETURN_WAIT_MS || '0');
    if (waitMs > 0 && Number.isFinite(waitMs)) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Issue fresh access token from current DB snapshot
    const freshJwt = await issueAccessTokenForUserTenant(userId, tenantId);

    // Redirect to frontend with the new token in query
    const frontBase = (process.env.FRONTEND_BASE_URL || 'http://localhost:4200').replace(/\/+$/,'');
    const sep = toPath.includes('?') ? '&' : '?';
    const redirectUrl = `${frontBase}${toPath}${sep}jwt=${encodeURIComponent(freshJwt)}`;

    res.redirect(302, redirectUrl);
  } catch (e) {
    console.error('[billing] handleBillingPortalReturn error', e);
    return res.status(500).json({ message: 'Portal return failed' });
  }
};

// Alias for routes that import `createPortalReturn`
exports.createPortalReturn = exports.handleBillingPortalReturn;
