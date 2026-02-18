const { getGraphClient } = require('./graphClient');
const { fetch } = require('undici');

class GraphMailService {
  constructor() {
    this.client = getGraphClient();
    this.defaultSender = process.env.MAIL_SENDER_UPN;
    this.saveToSent = String(process.env.MAIL_SAVE_TO_SENT || 'true').toLowerCase() === 'true';
    this.inlineLogo = String(process.env.MAIL_INLINE_LOGO || 'false').toLowerCase() === 'true';
    this.inlineLogoTimeoutMs = Number(process.env.MAIL_INLINE_LOGO_TIMEOUT_MS || 5000);
  }

  static #logoCache = new Map(); // url -> { bytesBase64, contentType, name }

  #recipients(list) {
    const arr = Array.isArray(list) ? list : [list];
    return arr
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map(address => ({ emailAddress: { address } }));
  }

  #attachment({ name, bytes, contentType, isInline, contentId }) {
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: contentType || 'application/octet-stream',
      contentBytes: bytes, // base64
      ...(isInline ? { isInline: true } : {}),
      ...(contentId ? { contentId: String(contentId) } : {}),
    };
  }

  async #fetchBase64(url, { timeoutMs }) {
    const cached = GraphMailService.#logoCache.get(url);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      const bytesBase64 = Buffer.from(arrayBuffer).toString('base64');
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const name = url.split('/').pop() || 'inline.bin';
      const record = { bytesBase64, contentType, name };
      GraphMailService.#logoCache.set(url, record);
      return record;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #maybeInlineLogo({ html, attachments }) {
    if (!this.inlineLogo) return { html, attachments };
    const inputHtml = String(html || '');
    if (!inputHtml) return { html, attachments };

    // Known logos used by services/mailTemplates.js
    const logoUrls = [
      'https://certs.atexdb.eu/public/index_logo.png',
      'https://certs.atexdb.eu/public/ATEXdb.png',
    ];

    const matchedUrl = logoUrls.find(u => inputHtml.includes(u));
    if (!matchedUrl) return { html, attachments };

    const logo = await this.#fetchBase64(matchedUrl, { timeoutMs: this.inlineLogoTimeoutMs });
    if (!logo) return { html, attachments };

    const contentId = 'tenant-logo';
    const alreadyAttached = (attachments || []).some(
      a => a && (a.contentId === contentId || a.name === logo.name) && a.isInline
    );

    const nextHtml = inputHtml.split(matchedUrl).join(`cid:${contentId}`);
    const nextAttachments = alreadyAttached
      ? attachments || []
      : [
          ...(attachments || []),
          { name: logo.name, bytes: logo.bytesBase64, contentType: logo.contentType, isInline: true, contentId },
        ];

    return { html: nextHtml, attachments: nextAttachments };
  }

  async sendMail({ to, subject, html, from, cc = [], bcc = [], attachments = [] }) {
    const sender = from || this.defaultSender;
    if (!sender) throw new Error('MAIL_SENDER_UPN is not set');

    const { html: finalHtml, attachments: finalAttachments } = await this.#maybeInlineLogo({
      html,
      attachments,
    });

    const message = {
      subject: subject || '',
      body: { contentType: 'HTML', content: finalHtml || '' },
      toRecipients: this.#recipients(to),
      ...(cc.length ? { ccRecipients: this.#recipients(cc) } : {}),
      ...(bcc.length ? { bccRecipients: this.#recipients(bcc) } : {}),
      ...(finalAttachments.length ? { attachments: finalAttachments.map(a => this.#attachment(a)) } : {}),
    };

    // Application perm: send as specific mailbox
    await this.client.api(`/users/${encodeURIComponent(sender)}/sendMail`).post({
      message,
      saveToSentItems: this.saveToSent,
    });
  }
}

module.exports = new GraphMailService();
