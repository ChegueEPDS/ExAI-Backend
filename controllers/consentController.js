const ConsentLog = require('../models/consentLog');

function normalizeConsent(v) {
  return v === 'granted' ? 'granted' : 'denied';
}

exports.recordConsentDecision = async (req, res) => {
  try {
    const body = req.body || {};
    const consentId = String(body.consentId || '').trim();
    if (!consentId) {
      return res.status(400).json({ message: 'consentId is required.' });
    }

    const analytics = normalizeConsent(String(body.analytics || '').trim().toLowerCase());
    const marketing = normalizeConsent(String(body.marketing || '').trim().toLowerCase());

    const policyVersion = String(body.policyVersion || 'v1').trim().slice(0, 64);
    const source = String(body.source || 'web').trim().slice(0, 32);
    const pageUrl = body.pageUrl != null ? String(body.pageUrl).trim().slice(0, 2048) : null;

    const user = req.user || null;
    const userId = user?.id ? String(user.id) : null;
    const tenantId = user?.tenantId ? String(user.tenantId) : null;
    const tenantType = user?.tenantType ? String(user.tenantType) : null;
    const plan = user?.plan ? String(user.plan) : null;

    const doc = await ConsentLog.create({
      consentId,
      source,
      policyVersion,
      analytics,
      marketing,
      userId,
      tenantId,
      tenantType,
      plan,
      pageUrl,
    });

    return res.status(201).json({ ok: true, id: String(doc._id) });
  } catch (err) {
    console.error('[consent] recordConsentDecision failed', err);
    return res.status(500).json({ message: 'Failed to record consent decision.' });
  }
};

