const User = require('../models/user');
const brevoService = require('../services/brevoService');
const emailPreferenceService = require('../services/emailPreferenceService');

function callerUserId(req) {
  return req.user?.id || req.user?._id || req.userId || req.scope?.userId || null;
}

function requestContext(req) {
  return {
    requestId: req.id || req.requestId || '',
    ip: req.ip || '',
    userAgent: String(req.get?.('user-agent') || '').slice(0, 500),
  };
}

exports.getMyEmailPreferences = async (req, res) => {
  try {
    const user = await User.findById(callerUserId(req)).select(
      'marketingEmailsEnabled newsletterEmailsEnabled preferredLanguage emailPreferenceSync'
    ).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(emailPreferenceService.preferenceResponse(user));
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load email preferences' });
  }
};

exports.updateMyEmailPreferences = async (req, res) => {
  try {
    const input = req.body || {};
    for (const key of ['usefulInformationEnabled', 'newsletterEnabled']) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') {
        return res.status(400).json({ error: `${key} must be a boolean` });
      }
    }
    if (input.preferredLanguage !== undefined && !['en', 'hu'].includes(String(input.preferredLanguage).toLowerCase())) {
      return res.status(400).json({ error: 'preferredLanguage must be en or hu' });
    }
    const result = await emailPreferenceService.updatePreferences(callerUserId(req), input, {
      source: 'settings',
      context: requestContext(req),
    });
    if (result.notFound) return res.status(404).json({ error: 'User not found' });
    return res.json(result.preferences);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update email preferences' });
  }
};

exports.handleBrevoMarketingWebhook = async (req, res) => {
  try {
    const expectedSecret = String(process.env.BREVO_WEBHOOK_SECRET || '');
    const suppliedSecret = String(req.get('x-brevo-webhook-secret') || req.query?.secret || '');
    if (!expectedSecret) return res.status(503).json({ error: 'Brevo webhook is not configured' });
    if (!suppliedSecret || suppliedSecret !== expectedSecret) return res.status(401).json({ error: 'Invalid webhook secret' });

    const event = String(req.body?.event || req.body?.type || '').toLowerCase();
    if (!event.includes('unsubscribe') && !event.includes('unsubscribed')) return res.status(202).json({ ok: true, ignored: true });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const managed = brevoService.getManagedEmailLists();
    const newsletterIds = Object.values(managed.newsletter);
    const payloadIds = [req.body?.listId, req.body?.list_id, req.body?.listIds]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .map(Number)
      .filter(Number.isFinite);
    const contact = await brevoService.getContact(email);
    const unsubscribedIds = Array.isArray(contact?.data?.listUnsubscribed)
      ? contact.data.listUnsubscribed.map(Number)
      : [];
    const affectedIds = [...new Set([...payloadIds, ...unsubscribedIds])];
    const disableNewsletter = affectedIds.some(id => newsletterIds.includes(id));
    const disableUsefulInformation = affectedIds.includes(managed.usefulInformation);
    if (!disableNewsletter && !disableUsefulInformation) return res.status(202).json({ ok: true, ignored: true });

    const user = await User.findOne({ email });
    if (!user) return res.status(202).json({ ok: true, ignored: true });
    const priorNewsletterIds = affectedIds.filter(id => newsletterIds.includes(id));
    if (priorNewsletterIds.length) {
      user.brevoNewsletterListIds = [...new Set([...(user.brevoNewsletterListIds || []), ...priorNewsletterIds])];
      await user.save();
    }
    const result = await emailPreferenceService.updatePreferences(user._id, {
      ...(disableNewsletter ? { newsletterEnabled: false } : {}),
      ...(disableUsefulInformation ? { usefulInformationEnabled: false } : {}),
    }, { source: 'brevo_webhook', context: requestContext(req) });
    return res.json({ ok: true, preferences: result.preferences });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to process Brevo webhook' });
  }
};
