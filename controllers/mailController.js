const mailSvc = require('../services/mailService');

exports.sendTestEmail = async (req, res) => {
  try {
    const { to, subject, html, from, cc, bcc, attachments } = req.body || {};
    if (!to || !subject || !html) {
      return res.status(400).json({ error: 'to, subject, html are required' });
    }
    await mailSvc.sendMail({ to, subject, html, from, cc, bcc, attachments });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[mail] send failed:', err?.response?.data || err);
    return res.status(500).json({ error: 'Send failed', detail: err?.message });
  }
};