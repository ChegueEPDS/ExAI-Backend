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

exports.listMailboxMessages = async (req, res) => {
  try {
    const folder = String(req.query?.folder || 'inbox').trim().toLowerCase();
    const top = Number(req.query?.top || 25);
    const skip = Number(req.query?.skip || 0);
    const items = await mailSvc.listMailboxMessages({ folder, top, skip });
    return res.json({
      mailbox: process.env.MAIL_SENDER_UPN || null,
      folder,
      skip: Math.max(skip || 0, 0),
      items,
    });
  } catch (err) {
    console.error('[mail] list mailbox failed:', err?.response?.data || err);
    return res.status(500).json({
      error: 'Mailbox read failed',
      detail: err?.message || 'Unknown error',
    });
  }
};

exports.getMailboxMessage = async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Message id is required' });
    const item = await mailSvc.getMailboxMessage(id);
    return res.json({
      mailbox: process.env.MAIL_SENDER_UPN || null,
      item,
    });
  } catch (err) {
    console.error('[mail] get mailbox message failed:', err?.response?.data || err);
    return res.status(500).json({
      error: 'Mailbox message read failed',
      detail: err?.message || 'Unknown error',
    });
  }
};
