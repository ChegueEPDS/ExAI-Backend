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

module.exports = {
  registrationEmailHtml,
  tenantInviteEmailHtml,
  forgotPasswordEmailHtml
};