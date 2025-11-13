// controllers/billingWebhookController.js
const Stripe = require('stripe');
const Tenant = require('../models/tenant');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const { migrateDeleteCompanyDataButKeepPublic } = require('../services/tenantCleanup');

const PRO_PRICE_ID  = process.env.STRIPE_PRICE_PRO;
const TEAM_PRICE_ID = process.env.STRIPE_PRICE_TEAM;
const PRO_PRICE_ID_YEARLY  = process.env.STRIPE_PRICE_PRO_YEARLY;
const TEAM_PRICE_ID_YEARLY = process.env.STRIPE_PRICE_TEAM_YEARLY;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// --- helpers ---
function slugifyTenantName(name) {
  if (!name || typeof name !== 'string') {
    return 'tenant-' + Math.random().toString(36).substring(2, 10);
  }
  let slug = name.toLowerCase()
    .replace(/[^a-z0-9-_.]/g, '-') // allowed chars only
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 48);
  if (!slug) slug = 'tenant-' + Math.random().toString(36).substring(2, 10);
  return slug;
}

async function ensureUniqueTenantName(base) {
  let name = slugifyTenantName(base);
  let uniqueName = name;
  let suffix = 1;
  while (await Tenant.findOne({ name: uniqueName })) {
    uniqueName = `${name}-${suffix++}`;
    if (uniqueName.length > 48) {
      uniqueName = uniqueName.substring(0, 48 - String(suffix).length - 1) + `-${suffix}`;
    }
  }
  return uniqueName;
}

function str(v) { return (v || '').toString().toLowerCase(); }

function resolveTierFromItem(item, subMeta) {
  const price = item?.price;
  const lookup = str(price?.lookup_key);
  const pid = price?.id;

  // Price ID or lookup_key based routing
  if (pid === TEAM_PRICE_ID || pid === TEAM_PRICE_ID_YEARLY || lookup === 'team' || lookup === 'team_yearly') {
    return 'team';
  }
  if (pid === PRO_PRICE_ID || pid === PRO_PRICE_ID_YEARLY || lookup === 'pro' || lookup === 'pro_yearly') {
    return 'pro';
  }

  // Metadata fallback (keeps legacy behavior)
  const metaPlan = str(subMeta?.plan || subMeta?.intent);
  if (metaPlan.includes('team')) return 'team';
  return 'pro';
}

function resolveBillingPeriod(item, subMeta) {
  // Prefer Stripe price recurring interval if present
  const interval = item?.price?.recurring?.interval;
  if (interval === 'year' || interval === 'month') return interval;

  // Fallback from metadata plan name
  const metaPlan = str(subMeta?.plan || subMeta?.intent);
  if (metaPlan.endsWith('_yearly')) return 'year';
  return 'month';
}

async function resolveTierWithStripeFallback(item, subMeta) {
  const local = resolveTierFromItem(item, subMeta);
  if (local === 'team' || local === 'pro') return local;
  try {
    const price = item?.price;
    if (!price) return 'pro';
    if (price.product) {
      const prod = await stripe.products.retrieve(price.product.toString());
      const metaTier = (prod?.metadata?.tier || prod?.metadata?.plan || '').toString().toLowerCase();
      if (metaTier === 'team' || metaTier === 'pro') return metaTier;
    }
  } catch (_) {}
  return 'pro';
}

async function upsertSubscriptionSnapshot(
  tenantId,
  {
    stripeCustomerId,
    stripeSubscriptionId,
    status,
    current_period_end,
    cancel_at_period_end,
    item,
    priceOverride,
    tier,
    billingPeriod,
  }
) {
  const price = priceOverride || item?.price || null;
  const qty = Number(item?.quantity ?? 0) || 0;
  const currentPeriodEnd = current_period_end ? new Date(current_period_end * 1000) : undefined;
  const bp = billingPeriod || (price?.recurring?.interval === 'year' ? 'year' : (price?.recurring?.interval === 'month' ? 'month' : 'month'));
  const payload = {
    tenantId,
    stripeCustomerId: stripeCustomerId || undefined,
    stripeSubscriptionId: stripeSubscriptionId || undefined,
    status: status || undefined,
    currentPeriodEnd: currentPeriodEnd || undefined,
    cancelAtPeriodEnd: !!cancel_at_period_end,
    seatsPurchased: qty,
    tier: tier || undefined,
    priceId: price?.id,
    productId: price?.product,
    billingPeriod: bp,
  };
  await Subscription.findOneAndUpdate({ tenantId }, payload, { upsert: true, new: true });
}

// --- controller (single exported handler) ---
exports.handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const ref = s.client_reference_id;
        const m = s?.metadata || {};
        const subId = s.subscription;
        const customerId = s.customer;

        const sub = await stripe.subscriptions.retrieve(subId);
        const item = sub.items.data[0];
        const price = item.price;
        let quantity = item.quantity || 1;

        let tier = await resolveTierWithStripeFallback(item, m);
        const billingPeriod = resolveBillingPeriod(item, m);

        let tenant = null;
        const isValidObjectId = ref && /^[a-fA-F0-9]{24}$/.test(ref);
        if (isValidObjectId) {
          const tenantRef = await Tenant.findById(ref);
          if (tenantRef) {
            tenant = tenantRef;
            if (tier === 'team') {
              quantity = Math.max(Number(quantity || 0), 5);
              tenant.plan = 'team';
              tenant.type = 'company';
              tenant.seats.max = quantity;
            } else {
              tenant.plan = 'pro';
              tenant.type = 'personal';
              tenant.seats.max = 1;
              quantity = 1;
            }
            tenant.stripeCustomerId = customerId;
            tenant.stripeSubscriptionId = subId;
            tenant.billingPeriod = billingPeriod; // cache billing period ('month' | 'year')
            await tenant.save();

            const buyerUserId = m.userId || null;
            if (buyerUserId && tier === 'team') {
              const buyer = await User.findById(buyerUserId);
              if (buyer) {
                const prevTenantId = buyer.tenantId ? String(buyer.tenantId) : null;
                buyer.tenantId = tenant._id;
                buyer.role = 'Admin';
                await buyer.save();

                if (!tenant.ownerUserId) {
                  tenant.ownerUserId = buyer._id;
                  await tenant.save();
                }

                if (prevTenantId && prevTenantId !== String(tenant._id)) {
                  const prev = await Tenant.findById(prevTenantId);
                  if (prev && prev.type === 'personal' && !prev.stripeSubscriptionId) {
                    const otherUsers = await User.countDocuments({ tenantId: prev._id, _id: { $ne: buyer._id } });
                    if (otherUsers === 0) {
                      await Tenant.deleteOne({ _id: prev._id });
                    }
                  }
                }
              }
            }

            const ownerId = tenant.ownerUserId;
            if (ownerId) {
              const owner = await User.findById(ownerId);
              if (owner) {
                if (tier === 'team') {
                  owner.tenantId = tenant._id;
                  owner.role = 'Admin';
                }
                await owner.save();
              }
            }

            await upsertSubscriptionSnapshot(tenant._id, {
              stripeCustomerId: customerId,
              stripeSubscriptionId: subId,
              status: sub.status,
              current_period_end: sub.current_period_end,
              cancel_at_period_end: sub.cancel_at_period_end,
              item,
              priceOverride: price,
              tier,
              billingPeriod
            });
            break;
          }
        }

        // free-first TEAM flow
        if (tier !== 'team') {
          if (m.intent === 'team') tier = 'team';
          else if (quantity >= 5) tier = 'team';
        }

        if (tier === 'team') {
          const buyerUserId = m.userId || null;
          const buyer = buyerUserId ? await User.findById(buyerUserId) : null;

          const baseName = m.companyName || buyer?.email || 'company';
          const uniqueName = await ensureUniqueTenantName(baseName);

          tenant = await Tenant.create({
            name: uniqueName,
            type: 'company',
            plan: 'team',
            ownerUserId: buyer?._id,
            seats: { max: Math.max(Number(quantity || 0), 5), used: 1 },
            seatsManaged: 'stripe',
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
            billingPeriod, // 'month' | 'year'
          });

          if (buyer) {
            const prevTenantId = buyer.tenantId ? String(buyer.tenantId) : null;
            buyer.tenantId = tenant._id;
            buyer.role = 'Admin';
            await buyer.save();

            if (!tenant.ownerUserId) {
              tenant.ownerUserId = buyer._id;
              await tenant.save();
            }

            if (prevTenantId && prevTenantId !== String(tenant._id)) {
              const prev = await Tenant.findById(prevTenantId);
              if (prev && prev.type === 'personal' && !prev.stripeSubscriptionId) {
                const otherUsers = await User.countDocuments({ tenantId: prev._id, _id: { $ne: buyer._id } });
                if (otherUsers === 0) {
                  await Tenant.deleteOne({ _id: prev._id });
                }
              }
            }
          }

          await upsertSubscriptionSnapshot(tenant._id, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
            status: sub.status,
            current_period_end: sub.current_period_end,
            cancel_at_period_end: sub.cancel_at_period_end,
            item,
            priceOverride: price,
            tier,
            billingPeriod
          });
        }

        break;
      }

      case 'customer.subscription.created': {
        const sub = event.data.object;
        let tenant = await Tenant.findOne({ stripeSubscriptionId: sub.id });
        if (!tenant && sub.customer) {
          tenant = await Tenant.findOne({ stripeCustomerId: sub.customer });
        }
        if (tenant) {
          const item = sub.items?.data?.[0];
          const price = item?.price;
          const tier = await resolveTierWithStripeFallback(item, sub?.metadata);
          const billingPeriod = resolveBillingPeriod(item, sub?.metadata);

          if (tier === 'team') {
            const q = Math.max(Number(item?.quantity || 0), 5);
            tenant.plan = 'team';
            tenant.type = 'company';
            tenant.seats = { ...(tenant.seats || {}), max: q, used: Math.min(tenant.seats?.used || 1, q) };
          } else {
            tenant.plan = 'pro';
            tenant.type = 'personal';
            tenant.seats = { ...(tenant.seats || {}), max: 1, used: Math.min(tenant.seats?.used || 1, 1) };
          }
          tenant.stripeCustomerId = sub.customer || tenant.stripeCustomerId;
          tenant.stripeSubscriptionId = sub.id || tenant.stripeSubscriptionId;
          tenant.seatsManaged = 'stripe';
          tenant.billingPeriod = billingPeriod;
          await tenant.save();

          // normalize once more
          if (tier === 'team') {
            if (tenant.plan !== 'team') tenant.plan = 'team';
            if (tenant.type !== 'company') tenant.type = 'company';
          } else {
            if (tenant.plan !== 'pro') tenant.plan = 'pro';
            if (tenant.type !== 'personal') tenant.type = 'personal';
          }
          await tenant.save();

          await upsertSubscriptionSnapshot(tenant._id, {
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            status: sub.status,
            current_period_end: sub.current_period_end,
            cancel_at_period_end: sub.cancel_at_period_end,
            item,
            priceOverride: price,
            tier,
            billingPeriod
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;

        // 1) Find tenant by subscriptionId, or fall back to customer id
        let t = await Tenant.findOne({ stripeSubscriptionId: sub.id });
        if (!t && sub.customer) {
          const tByCust = await Tenant.findOne({ stripeCustomerId: sub.customer });
          if (tByCust) {
            tByCust.stripeSubscriptionId = sub.id; // attach for next time
            await tByCust.save();
            t = tByCust;
          }
        }
        if (!t) break;

        // 2) Resolve item/price and tier (pro|team) with fallback
        const item = sub.items?.data?.[0];
        const price = item?.price;
        const tier = await resolveTierWithStripeFallback(item, sub?.metadata);
        const billingPeriod = resolveBillingPeriod(item, sub?.metadata);

        // 3) Identify the actor user who initiated the portal change (if any)
        // Prefer subscription metadata.userId, otherwise read Stripe Customer.metadata.lastPortalUserId
        let actorUserId = sub?.metadata?.userId || null;
        if (!actorUserId && sub.customer) {
          try {
            const customer = await stripe.customers.retrieve(sub.customer.toString());
            const fromMeta = customer?.metadata?.lastPortalUserId;
            if (fromMeta) actorUserId = fromMeta;
          } catch (e) {
            console.warn('[webhook] could not read customer metadata:', e?.message || e);
          }
        }

        // 4) Sync tenant basics from Stripe
        t.stripeCustomerId = sub.customer || t.stripeCustomerId;
        t.stripeSubscriptionId = sub.id || t.stripeSubscriptionId;
        t.seatsManaged = 'stripe';
        t.billingPeriod = billingPeriod;

        if (tier === 'team') {
          const q = Math.max(Number(item?.quantity || 0), 5);
          t.plan = 'team';
          t.type = 'company';
          t.seats.max = q;
          t.seats.used = Math.min(t.seats?.used || 1, q);
        } else {
          t.plan = 'pro';
          t.type = 'personal';
          t.seats.max = 1;
          t.seats.used = Math.min(t.seats?.used || 1, 1);
        }
        await t.save();

        // 5) Upsert subscription snapshot (tier/status/seats)
        await upsertSubscriptionSnapshot(t._id, {
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
          item,
          priceOverride: price,
          tier,
          billingPeriod
        });
        await Subscription.findOneAndUpdate(
          { tenantId: t._id },
          { seatsPurchased: (tier === 'team') ? Math.max(Number(item?.quantity || 0), 5) : 1, tier, status: sub.status, billingPeriod },
          { upsert: true }
        );

        // 6) Role adjustments:
        if (tier === 'team') {
          // Upgrade path (pro -> team): make the actor Admin and owner (if owner missing)
          if (actorUserId) {
            const actor = await User.findById(actorUserId);
            if (actor) {
              actor.tenantId = t._id;
              actor.role = 'Admin';
              await actor.save();
              if (!t.ownerUserId) {
                t.ownerUserId = actor._id;
                await t.save();
              }
            }
          } else if (t.ownerUserId) {
            // Ensure current owner is Admin on company tenant
            const owner = await User.findById(t.ownerUserId);
            if (owner && owner.role !== 'Admin') {
              owner.role = 'Admin';
              await owner.save();
            }
          }
        } else {
          // Downgrade path (team -> pro): on a personal tenant, don't leave company Admins hanging
          // Minimum: demote owner to User
          if (t.ownerUserId) {
            const owner = await User.findById(t.ownerUserId);
            if (owner && owner.role !== 'User') {
              owner.role = 'User';
              await owner.save();
            }
          }
          // Optionally demote the actor too if present
          if (actorUserId) {
            const actor = await User.findById(actorUserId);
            if (actor && actor.role !== 'User') {
              actor.role = 'User';
              await actor.save();
            }
          }
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const tenant = await Tenant.findOne({ stripeSubscriptionId: sub.id });
        if (tenant) {
          if (tenant.type === 'company') {
            await migrateDeleteCompanyDataButKeepPublic(String(tenant._id));
          }
          tenant.plan = 'free';
          tenant.type = 'personal';
          tenant.seats.max = 1;
          tenant.seats.used = Math.min(tenant.seats.used || 0, 1);
          tenant.seatsManaged = tenant.seatsManaged || 'stripe';
          tenant.stripeSubscriptionId = undefined;
          tenant.billingPeriod = undefined;
          await tenant.save();

          const ownerId = tenant.ownerUserId;
          if (ownerId) {
            const owner = await User.findById(ownerId);
            if (owner) {
              owner.role = 'User';
              await owner.save();
            }
          }

          await upsertSubscriptionSnapshot(tenant._id, {
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            status: 'canceled',
            current_period_end: sub.current_period_end,
            cancel_at_period_end: sub.cancel_at_period_end,
            item: sub.items?.data?.[0],
            priceOverride: sub.items?.data?.[0]?.price,
            tier: undefined,
            billingPeriod: sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'year' : 'month'
          });

          await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            { tier: 'free', status: 'canceled' },
            { upsert: true }
          );
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const tenant = await Tenant.findOne({ stripeCustomerId: inv.customer });
        if (tenant) {
          await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            { status: 'past_due' },
            { upsert: true }
          );
        }
        break;
      }

      case 'invoice.paid': {
        const inv = event.data.object;
        const tenant = await Tenant.findOne({ stripeCustomerId: inv.customer });
        if (tenant) {
          await Subscription.findOneAndUpdate(
            { tenantId: tenant._id },
            { status: 'active' },
            { upsert: true }
          );
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[webhook] handler error', e);
    res.status(500).json({ message: e.message });
  }
};