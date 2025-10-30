// services/mailTemplates.js

function baseTemplate({ title, bodyHtml }) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <!-- A legtöbb kliens inline stílusokat támogat, maradjunk táblás layoutnál -->
  </head>
  <body style="margin:0; padding:0; background:#f5f6f8; font-family: Arial, sans-serif; color:#333;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#fff; border-radius:8px; overflow:hidden;">
            <tr>
              <td align="center" style="padding:20px; background:#ebebeb;">
                <!-- ⚠️ SVG helyett PNG + e-mail safe inline stílusok -->
                <img src="https://certs.atexdb.eu/public/ATEXdb.png"
                     alt="ATEXdb Logo"
                     width="220" height="auto"
                     style="display:block; outline:none; border:0; text-decoration:none; -ms-interpolation-mode:bicubic; max-width:220px; height:auto;" />
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px; background:#ebebeb; font-size:12px; color:#777;">
                © ${new Date().getFullYear()} ATEXdb Certs. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function registrationEmailHtml({ firstName, lastName, loginUrl }) {
  // loginUrl legyen teljes https URL
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  return baseTemplate({
    title: 'Welcome to ATEXdb Certs',
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>Thank you for registering on the <strong>ATEXdb Certs</strong> platform.</p>
      <p>You can now log in and start managing your certificates and compliance documents.</p>
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Go to ATEXdb Certs
        </a>
      </p>
      <p>Best regards,<br/>The ATEXdb Team<br/>
         <a href="https://certs.atexdb.eu" target="_blank" rel="noopener noreferrer">certs.atexdb.eu</a>
      </p>
    `,
  });
}

function tenantInviteEmailHtml({ firstName, lastName, tenantName, loginUrl, password }) {
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  return baseTemplate({
    title: 'You have been added to a tenant',
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>You have been added to the tenant <strong>${tenantName}</strong> on the <strong>ATEXdb Certs</strong> platform.</p>
      <p>You can log in using your email address${password ? ` and the password below` : ''}:</p>
      ${
        password
          ? `<p style="background:#ebebeb; padding:10px; border-radius:4px; font-family:monospace; font-size:14px; text-align:center; margin:16px 0;">${password}</p>`
          : ''
      }
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Log in to ATEXdb Certs
        </a>
      </p>
      <p>Best regards,<br/>The ATEXdb Team<br/>
         <a href="https://certs.atexdb.eu" target="_blank" rel="noopener noreferrer">certs.atexdb.eu</a>
      </p>
    `,
  });
}

function forgotPasswordEmailHtml({ firstName, lastName, loginUrl, tempPassword }) {
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  return baseTemplate({
    title: 'Your temporary password',
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName || ''} ${lastName || ''},</h2>
      <p>We received a request to reset your password for <strong>ATEXdb Certs</strong>.</p>
      <p>Here is your temporary password:</p>
      <div style="background:#ebebeb; padding:12px 14px; border-radius:6px; font-family:monospace; font-size:16px; text-align:center;">
        <span style="word-break:break-all;">${tempPassword}</span>
      </div>
      <p style="margin-top:10px; font-size:13px; color:#555;">
        For security, please log in and change your password immediately.
      </p>
      <p style="margin:28px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:16px; display:inline-block;">
          Go to ATEXdb Certs
        </a>
      </p>
      <p>Best regards,<br/>The ATEXdb Team<br/>
         <a href="https://certs.atexdb.eu" target="_blank" rel="noopener noreferrer">certs.atexdb.eu</a>
      </p>
    `,
  });
}

/**
 * Upload completion email (HTML only)
 */
function uploadCompletedEmail(user = {}, stats = {}) {
  const { firstName = '', lastName = '' } = user;
  const { uploadId = '', total = 0, saved = 0, discarded = 0 } = stats;

  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'there';

  return baseTemplate({
    title: 'Upload processing completed',
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${escapeHtml(fullName)},</h2>
      <p>Your certificate upload with ID <strong>${escapeHtml(uploadId)}</strong> has been fully processed.</p>

      <table style="width:100%; max-width:400px; margin:12px 0; border-collapse:collapse;">
        <tr><td style="padding:6px 0;">📄 <strong>Total files:</strong></td><td style="text-align:right;">${Number(total) || 0}</td></tr>
        <tr><td style="padding:6px 0;">✅ <strong>Finalized:</strong></td><td style="text-align:right;">${Number(saved) || 0}</td></tr>
        <tr><td style="padding:6px 0;">🚫 <strong>Discarded:</strong></td><td style="text-align:right;">${Number(discarded) || 0}</td></tr>
      </table>

      <p>You can review the results in the web application.</p>

      <p>Some of the uploaded certificates might have been discarded during verification, either because their content did not meet validation requirements or because an identical record already exists in our database.</p>

      <p style="margin-top:16px;">Thank you for using <strong>ATEXdb Certs</strong>.</p>
    `
  });
}

/** Simple HTML escape for safety */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  registrationEmailHtml,
  tenantInviteEmailHtml,
  forgotPasswordEmailHtml,
  uploadCompletedEmail,
};