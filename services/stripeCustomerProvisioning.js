const brevoService = require('./brevoService');

/**
 * Ensure a Stripe Customer exists for a tenant, and trigger Brevo sync on creation.
 * Expects a Mongoose Tenant document (not lean).
 */
async function ensureStripeCustomerForTenant({ stripe, tenantDoc, user }) {
  if (!stripe || !tenantDoc) return null;
  if (tenantDoc.stripeCustomerId) return tenantDoc.stripeCustomerId;

  const email = user?.email || null;
  const customer = await stripe.customers.create({
    name: tenantDoc.name,
    email: email || undefined,
    metadata: {
      tenantId: String(tenantDoc._id),
      userId: user?._id ? String(user._id) : (user?.id ? String(user.id) : ''),
      plan: String(tenantDoc.plan || 'free'),
      tenantType: String(tenantDoc.type || ''),
    },
  });

  tenantDoc.stripeCustomerId = customer.id;
  await tenantDoc.save();

  // Fire-and-forget Brevo sync (do not block the main flow)
  brevoService.onStripeCustomerCreated({
    email: email,
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    stripeCustomerId: customer.id,
    tenant: tenantDoc,
  });

  return customer.id;
}

module.exports = {
  ensureStripeCustomerForTenant,
};
