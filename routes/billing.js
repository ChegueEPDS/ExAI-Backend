// routes/billing.js
const express = require('express');
const router = express.Router();

const {
  createCheckoutSession,
  createBillingPortal,
  handleBillingPortalReturn,
  applyFreeNextInvoice,
  updateQuantity,
  listInvoicesForMe,
  grantCredit,
  pauseSubscription,
  resumeSubscription,
  grantManualLicense,
  revokeManualLicense
} = require('../controllers/billingController');

// auth middleware
const { requireAuth, requireRole } = require('../middlewares/authMiddleware');

// Tenant modell a validáláshoz
const Tenant = require('../models/tenant');

/**
 * Route-szintű normalizáló/validáló middleware a Checkout-hoz
 * - plan: 'pro' | 'team' | 'pro_yearly' | 'team_yearly' (kötelező)
 * - tenantId: kötelező (nálatok mindig van)
 * - team: seats kötelező és min. 5, tenant.type='company'
 * - pro: seats = 1, tenant.type='personal'
 */
async function validateCheckoutBody(req, res, next) {
  try {
    const body = req.body || {};
    const plan = String(body.plan || '').trim().toLowerCase();
    const rawTenantId = body.tenantId != null ? String(body.tenantId).trim() : '';
    const rawSeats = body.seats != null ? Number(body.seats) : undefined;
    const companyName = body.companyName != null ? String(body.companyName).trim() : '';

    // 1) Plan validation
    if (!['pro', 'team', 'pro_yearly', 'team_yearly'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan. Use "pro", "team", "pro_yearly", "team_yearly".' });
    }

    // 2) If tenantId is provided => strict validation against DB (legacy / advanced flows)
    if (rawTenantId) {
      const tenant = await Tenant.findById(rawTenantId).select('_id name type plan seats').lean();
      if (!tenant) {
        return res.status(404).json({ message: 'Tenant not found.' });
      }

      if (plan.startsWith('team')) {
        // company + min. 5 seat
        const seats = Number.isInteger(rawSeats) ? rawSeats : 5;
        if (seats < 5) {
          return res.status(400).json({ message: 'Team plan requires at least 5 seats.' });
        }
        if (tenant.type !== 'company') {
          return res.status(400).json({ message: 'Team plan requires a company tenant.' });
        }
        req.body.plan = plan;
        req.body.seats = seats;
        req.body.tenantId = rawTenantId;
        return next();
      }

      // PRO with existing tenant → must be personal
      if (tenant.type !== 'personal') {
        return res.status(400).json({ message: 'Pro plan requires a personal tenant.' });
      }
      req.body.plan = plan;
      req.body.seats = 1; // fixed for pro
      req.body.tenantId = rawTenantId;
      return next();
    }

    // 3) Free-first mode (NO tenantId yet)
    if (plan.startsWith('team')) {
      // For team we need at least a desired seats count and a companyName to create later at webhook.
      const seats = Number.isInteger(rawSeats) ? rawSeats : NaN;
      if (!Number.isInteger(seats) || seats < 5) {
        return res.status(400).json({ message: 'Team plan requires at least 5 seats.' });
      }
      if (!companyName) {
        return res.status(400).json({ message: 'Team plan requires a companyName when tenantId is not provided.' });
      }
      // normalize body for controller
      req.body.plan = plan;
      req.body.seats = seats;
      // tenantId intentionally omitted (free-first)
      return next();
    }

    // PRO free-first: allow without tenantId; seats fixed to 1
    req.body.plan = plan;
    req.body.seats = 1;
    // tenantId intentionally omitted
    return next();
  } catch (err) {
    console.error('[validateCheckoutBody] error', err);
    return res.status(500).json({ message: 'Checkout validation failed.' });
  }
}

// --- Billing endpointok ---

// Checkout: auth + normalizálás
router.post('/checkout', requireAuth, validateCheckoutBody, createCheckoutSession);

// Billing portal (Stripe Customer Portal)
router.post('/portal', requireAuth, createBillingPortal);

// Portalból visszatérés kezelése
router.get('/portal/return', handleBillingPortalReturn);

// Számlák lekérdezése
router.get('/invoices', requireAuth, listInvoicesForMe);


// Egyszeri jóváírás a következő számlára
router.post('/free-next-invoice', requireAuth, applyFreeNextInvoice);

// Mennyiség frissítése (seat szám) – itt is érdemes auth
router.post('/update-quantity', requireAuth, updateQuantity);

// Jóváírás (credit) adása
router.post('/grant-credit', requireAuth, grantCredit);

// Előfizetés szüneteltetése / folytatása
router.post('/pause', requireAuth, pauseSubscription);
router.post('/resume', requireAuth, resumeSubscription);

// Manuális licenc csak SuperAdminnak
router.post('/grant-manual-license', requireAuth, requireRole('SuperAdmin'), grantManualLicense);
router.post('/revoke-manual-license', requireAuth, requireRole('SuperAdmin'), revokeManualLicense);

module.exports = router;