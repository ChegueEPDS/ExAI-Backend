// services/mailTemplates.js

function isIndexTenant(tenantName) {
  return (tenantName || '').toLowerCase() === 'index';
}

function getTenantBaseUrl(tenantName) {
  return isIndexTenant(tenantName) ? 'https://exai.ind-ex.ae' : 'https://certs.atexdb.eu';
}

function buildTenantUrl(tenantName, path = '') {
  const base = getTenantBaseUrl(tenantName).replace(/\/+$/, '');
  if (!path) return base;
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  return `${base}/${normalizedPath}`;
}

function displayHost(url) {
  return String(url || '').replace(/^https?:\/\//i, '');
}

function baseTemplate({ title, bodyHtml, tenantName }) {
  const isIndex = isIndexTenant(tenantName);
  const logoUrl = isIndex ? 'https://certs.atexdb.eu/public/index_logo.png' : 'https://certs.atexdb.eu/public/ATEXdb.png';
  const logoAlt = isIndex ? 'ExAI IndEx Logo' : 'ATEXdb Certs Logo';
  const footerName = isIndex ? 'ExAI IndEx' : 'ATEXdb Certs';
  const footerUrl = buildTenantUrl(tenantName);
  const footerUrlLabel = displayHost(footerUrl);

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
                <img src="${logoUrl}"
                     alt="${logoAlt}"
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
                © ${new Date().getFullYear()} ${footerName}. All rights reserved.
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

function registrationEmailHtml({ firstName, lastName, loginUrl, tenantName }) {
  // loginUrl legyen teljes https URL
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  const portalUrl = buildTenantUrl(tenantName);
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'Welcome to ATEXdb Certs',
    tenantName,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>Thank you for registering on the <strong>${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}</strong> platform.</p>
      <p>You can now log in and start managing your certificates and compliance documents.</p>
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Go to ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}
        </a>
      </p>
      <p>Best regards,<br/>The ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb'} Team<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

function tenantInviteEmailHtml({ firstName, lastName, tenantName, loginUrl, password }) {
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  const portalUrl = buildTenantUrl(tenantName);
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'You have been added to a tenant',
    tenantName,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>You have been added to the tenant <strong>${tenantName}</strong> on the <strong>${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}</strong> platform.</p>
      <p>You can log in using your email address${password ? ` and the password below` : ''}:</p>
      ${
        password
          ? `<p style="background:#ebebeb; padding:10px; border-radius:4px; font-family:monospace; font-size:14px; text-align:center; margin:16px 0;">${password}</p>`
          : ''
      }
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Log in to ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}
        </a>
      </p>
      <p>Best regards,<br/>The ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb'} Team<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

function forgotPasswordEmailHtml({ firstName, lastName, loginUrl, tempPassword, tenantName }) {
  const safeLoginUrl = loginUrl?.startsWith('http') ? loginUrl : `https://${loginUrl}`;
  const portalUrl = buildTenantUrl(tenantName);
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'Your temporary password',
    tenantName,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName || ''} ${lastName || ''},</h2>
      <p>We received a request to reset your password for <strong>${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}</strong>.</p>
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
          Go to ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}
        </a>
      </p>
      <p>Best regards,<br/>The ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb'} Team<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

/**
 * Upload completion email (HTML only)
 */
function uploadCompletedEmail(user = {}, stats = {}, tenantName) {
  const { firstName = '', lastName = '' } = user;
  const { uploadId = '', total = 0, saved = 0, discarded = 0 } = stats;

  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'there';

  return baseTemplate({
    title: 'Upload processing completed',
    tenantName,
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

      <p style="margin-top:16px;">Thank you for using <strong>${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}</strong>.</p>
    `
  });
}

function certificateRequestFulfilledEmail({ firstName, lastName, certNo, request = {}, tenantName }) {
  const {
    certNo: requestedCertNo = '',
    manufacturer = '',
    model = '',
    status = 'fulfilled',
  } = request || {};

  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'there';
  const safeUploadedCertNo = escapeHtml(certNo || '');
  const safeRequestedCertNo = escapeHtml(requestedCertNo || '');
  const safeManufacturer = escapeHtml(manufacturer || '');
  const safeModel = escapeHtml(model || '');
  const safeStatus = escapeHtml(status || 'fulfilled');

  const appUrl = buildTenantUrl(tenantName, 'cert?tab=db');
  const appUrlLabel = displayHost(appUrl);

  return baseTemplate({
    title: 'Your requested certificate is available',
    tenantName,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${escapeHtml(fullName)},</h2>
      <p>The certificate you requested is now available in <strong>${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}</strong>.</p>

      <p style="margin:16px 0 8px 0;"><strong>Uploaded certificate:</strong></p>
      <div style="background:#ebebeb; padding:10px 12px; border-radius:6px; font-family:monospace; font-size:15px;">
        ${safeUploadedCertNo || 'N/A'}
      </div>

      <p style="margin:20px 0 6px 0;"><strong>Request details</strong></p>
      <table style="width:100%; max-width:480px; margin:0 0 16px 0; border-collapse:collapse;">
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Requested cert number:</td>
          <td style="padding:6px 0; text-align:right;">${safeRequestedCertNo || '—'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Manufacturer:</td>
          <td style="padding:6px 0; text-align:right;">${safeManufacturer || '—'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Model:</td>
          <td style="padding:6px 0; text-align:right;">${safeModel || '—'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Status:</td>
          <td style="padding:6px 0; text-align:right;">${safeStatus}</td>
        </tr>
      </table>

      <p>You can view this certificate and related records in the database.</p>

      <p style="margin:24px 0; text-align:center;">
        <a href="${appUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:16px; display:inline-block;">
          Go to ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb Certs'}
        </a>
      </p>

      <p>Best regards,<br/>The ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb'} Team<br/>
         <a href="${appUrl}" target="_blank" rel="noopener noreferrer">${appUrlLabel}</a>
      </p>
    `,
  });
}

function reportExportReadyEmail({ firstName, lastName, fileName, downloadUrl, jobId, tenantName }) {
  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'there';
  const safeFileName = escapeHtml(fileName || 'export.zip');
  const safeJobId = escapeHtml(jobId || '');
  const safeDownloadUrl = downloadUrl && downloadUrl.startsWith('http') ? downloadUrl : null;
  const portalUrl = buildTenantUrl(tenantName, 'notifications');
  const portalLabel = displayHost(portalUrl);

  return baseTemplate({
    title: 'Your export is ready',
    tenantName,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${escapeHtml(fullName)},</h2>
      <p>The ZIP export you requested is now ready.</p>
      <table style="width:100%; max-width:420px; margin:12px 0; border-collapse:collapse;">
        <tr>
          <td style="padding:6px 0; font-weight:bold;">File name:</td>
          <td style="padding:6px 0; text-align:right;">${safeFileName}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Job ID:</td>
          <td style="padding:6px 0; text-align:right;">${safeJobId || '—'}</td>
        </tr>
      </table>
      ${
        safeDownloadUrl
          ? `<p style="margin:28px 0; text-align:center;">
              <a href="${safeDownloadUrl}" target="_blank" rel="noopener noreferrer"
                 style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:16px; display:inline-block;">
                Download ZIP
              </a>
            </p>`
          : `<p>You can download the ZIP from the application by opening the Exports section.</p>`
      }
      <p>If the download link has expired, please sign in to the platform and navigate to <strong>Notifications → Exports</strong> to regenerate it.</p>
      <p style="margin-top:20px;">Open the portal: <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalLabel}</a></p>
      <p>Best regards,<br/>The ${tenantName?.toLowerCase()==='index' ? 'ExAI IndEx' : 'ATEXdb'} Team</p>
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
  certificateRequestFulfilledEmail,
  reportExportReadyEmail,
};
