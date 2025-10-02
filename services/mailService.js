const { getGraphClient } = require('./graphClient');

class GraphMailService {
  constructor() {
    this.client = getGraphClient();
    this.defaultSender = process.env.MAIL_SENDER_UPN;
    this.saveToSent = String(process.env.MAIL_SAVE_TO_SENT || 'true').toLowerCase() === 'true';
  }

  #recipients(list) {
    const arr = Array.isArray(list) ? list : [list];
    return arr
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map(address => ({ emailAddress: { address } }));
  }

  #attachment({ name, bytes, contentType }) {
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: contentType || 'application/octet-stream',
      contentBytes: bytes, // base64
    };
  }

  async sendMail({ to, subject, html, from, cc = [], bcc = [], attachments = [] }) {
    const sender = from || this.defaultSender;
    if (!sender) throw new Error('MAIL_SENDER_UPN is not set');

    const message = {
      subject: subject || '',
      body: { contentType: 'HTML', content: html || '' },
      toRecipients: this.#recipients(to),
      ...(cc.length ? { ccRecipients: this.#recipients(cc) } : {}),
      ...(bcc.length ? { bccRecipients: this.#recipients(bcc) } : {}),
      ...(attachments.length ? { attachments: attachments.map(a => this.#attachment(a)) } : {}),
    };

    // Application perm: send as specific mailbox
    await this.client.api(`/users/${encodeURIComponent(sender)}/sendMail`).post({
      message,
      saveToSentItems: this.saveToSent,
    });
  }
}

module.exports = new GraphMailService();