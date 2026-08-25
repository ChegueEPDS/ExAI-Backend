// services/mailTemplates.js

const EMAIL_BRANDS = Object.freeze({
  atexdb: {
    key: 'atexdb',
    name: 'ATEXdb',
    productName: 'ATEXdb Certs',
    footerName: 'ATEXdb',
    legalEntityName: 'EPDS Kft.',
    legalAddress: '1154 Budapest, Kozák tér 13-16.',
    legalEmail: 'info@epds.hu',
    companyRegistrationNumber: '01 09 291697',
    taxNumber: '25834138-2-42',
    teamName: 'ATEXdb Team',
    baseUrl: 'https://certs.atexdb.eu',
    logoUrl: 'https://certs.atexdb.eu/public/ATEXdb.png',
    logoAlt: 'ATEXdb logo',
    primary: '#f8d201',
    ink: '#131313',
    header: '#ffffff',
    surface: '#f5f7f9',
    soft: '#f4f1df',
  },
  index: {
    key: 'index',
    name: 'ExAI IndEx',
    productName: 'ExAI IndEx',
    footerName: 'ExAI IndEx',
    legalEntityName: 'EPDS Kft.',
    legalAddress: '1154 Budapest, Kozák tér 13-16.',
    legalEmail: 'info@epds.hu',
    companyRegistrationNumber: '01 09 291697',
    taxNumber: '25834138-2-42',
    teamName: 'ExAI IndEx Team',
    baseUrl: 'https://exai.ind-ex.ae',
    logoUrl: 'https://certs.atexdb.eu/public/index_logo.png',
    logoAlt: 'ExAI IndEx logo',
    primary: '#fff100',
    ink: '#0f172a',
    header: '#0f172a',
    surface: '#f4f7ff',
    soft: '#e8f1fb',
  },
});

function isIndexTenant(tenantName) {
  return (tenantName || '').toLowerCase() === 'index';
}

function isIndexUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return host === 'exai.ind-ex.ae' || host.endsWith('.ind-ex.ae');
  } catch (_) {
    return false;
  }
}

function resolveEmailBrand({ tenantName, baseUrl, forceBrand } = {}) {
  if (forceBrand === 'atexdb') return EMAIL_BRANDS.atexdb;
  if (forceBrand === 'index') return EMAIL_BRANDS.index;
  if (String(baseUrl || '').trim()) {
    return isIndexUrl(baseUrl) ? EMAIL_BRANDS.index : EMAIL_BRANDS.atexdb;
  }
  return isIndexTenant(tenantName) ? EMAIL_BRANDS.index : EMAIL_BRANDS.atexdb;
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

function normalizeBaseUrl(tenantName, baseUrl) {
  const input = String(baseUrl || '').trim();
  if (!input) return getTenantBaseUrl(tenantName).replace(/\/+$/, '');
  try {
    const u = new URL(input.startsWith('http') ? input : `https://${input}`);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return getTenantBaseUrl(tenantName).replace(/\/+$/, '');
  }
}

function withBaseOrigin(baseUrl, rawUrl, fallbackPath = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const input = String(rawUrl || '').trim();
  if (!input) return fallbackPath ? `${base}/${String(fallbackPath).replace(/^\/+/, '')}` : `${base}/`;

  try {
    if (input.startsWith('/')) {
      if (fallbackPath && (input === '/' || input === '')) {
        return `${base}/${String(fallbackPath).replace(/^\/+/, '')}`;
      }
      return `${base}${input}`;
    }
    const u = new URL(input.startsWith('http') ? input : `https://${input}`);
    if (fallbackPath && (!u.pathname || u.pathname === '/') && !u.search && !u.hash) {
      return `${base}/${String(fallbackPath).replace(/^\/+/, '')}`;
    }
    return `${base}${u.pathname || '/'}${u.search || ''}${u.hash || ''}`;
  } catch (_) {
    return fallbackPath ? `${base}/${String(fallbackPath).replace(/^\/+/, '')}` : `${base}/`;
  }
}

function displayHost(url) {
  return String(url || '').replace(/^https?:\/\//i, '');
}

const PRO_EMAIL_FEATURES = Object.freeze([
  {
    image: 'email-pro-unlimited-downloads.webp',
    title: 'Unlimited certificate downloads',
    description: 'Keep working without the daily Free-plan download limit.',
  },
  {
    image: 'email-pro-certificate-database.webp',
    title: 'Your own certificate database',
    description: 'Save and organise the documents you use in one searchable place.',
  },
  {
    image: 'email-pro-exai-assistant.webp',
    title: 'ExAI certificate assistant',
    description: 'Read and understand complex certificate documents faster.',
  },
]);

const TEAM_EMAIL_FEATURES = Object.freeze([
  {
    image: 'email-team-collaboration.webp',
    title: 'A shared workspace for your team',
    description: 'Work together with at least five seats and shared certificate access.',
  },
  {
    image: 'email-team-certificate-database.webp',
    title: 'Central certificate management',
    description: 'Keep your organisation’s certificates structured and easy to find.',
  },
  {
    image: 'email-team-projects-reports.webp',
    title: 'Projects and reports',
    description: 'Manage assets in ExAI Projects and turn your data into practical reports.',
  },
]);

const ATEXDB_START_FEATURES = Object.freeze([
  {
    image: 'email-start-download-certificate.webp',
    title: 'Download the certificate you need',
    description: 'Search the ATEXdb database, open the right certificate and download it when you need it.',
  },
  {
    image: 'email-start-contribute-upload.webp',
    title: 'Contribute, upload and earn rewards',
    description: 'Share certificates that are missing from ATEXdb. Every approved upload helps the community and counts towards your next free Team month.',
  },
  {
    image: 'email-start-request-community.webp',
    title: 'Request what is missing',
    description: 'Can’t find a certificate? Publish a request so the ATEXdb community can help locate and share it - helping you and everyone who needs it later.',
  },
]);

const ATEXDB_ACCESS_FEATURES = Object.freeze([
  {
    image: 'email-start-download-certificate.webp',
    title: 'Find verified ATEX certificates',
    description: 'Search the shared database and quickly access the certificate documents you need.',
  },
  {
    image: 'email-start-request-community.webp',
    title: 'Ask the community for missing documents',
    description: 'Publish a request when a certificate is missing so other members can help make it available.',
  },
  {
    image: 'email-start-contribute-upload.webp',
    title: 'Upload and organise your certificates',
    description: 'Contribute documents, help strengthen the database and work towards upload rewards.',
  },
  {
    image: 'email-pro-exai-assistant.webp',
    title: 'Understand documents with AI support',
    description: 'Use ExAI to read and understand complex certificate information more efficiently.',
  },
]);

function renderFeatureCards(features = []) {
  if (!Array.isArray(features) || !features.length) return '';
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0;border-collapse:separate;border-spacing:0 10px;">
      ${features.map((feature) => `
        <tr>
          <td width="164" valign="middle" style="padding:0 14px 0 0;">
            <div data-email-image-slot="${escapeHtml(feature.image)}"
                 style="width:150px;height:92px;border:1px dashed #a6a6a6;border-radius:10px;background:#f5f7f9;color:#626b73;font-size:11px;line-height:1.35;text-align:center;display:table;">
              <span style="display:table-cell;vertical-align:middle;padding:8px;">Image placeholder<br/><strong>${escapeHtml(feature.image)}</strong></span>
            </div>
          </td>
          <td valign="middle" style="padding:12px 14px;background:#f5f7f9;border-radius:10px;">
            <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${escapeHtml(feature.title)}</div>
            <div style="font-size:13px;line-height:1.5;color:#4d5963;">${escapeHtml(feature.description)}</div>
          </td>
        </tr>
      `).join('')}
    </table>
  `;
}

function baseTemplate({ title, bodyHtml, tenantName, baseUrl, forceBrand }) {
  const brand = resolveEmailBrand({ tenantName, baseUrl, forceBrand });
  const effectiveBaseUrl = forceBrand ? brand.baseUrl : normalizeBaseUrl(tenantName, baseUrl);
  const brandedBody = String(bodyHtml || '')
    .replace(/#f8d201/gi, brand.primary)
    .replace(/#131313/gi, brand.ink)
    .replace(/#ebebeb/gi, brand.soft);
  const footerUrl = effectiveBaseUrl;
  const footerUrlLabel = displayHost(footerUrl);
  const legalFooter = brand.legalEntityName
    ? `
      <div style="margin-top:10px;line-height:1.6;">
        Operated by ${escapeHtml(brand.legalEntityName)}<br/>
        Company registration number: ${escapeHtml(brand.companyRegistrationNumber)}<br/>
        Tax number: ${escapeHtml(brand.taxNumber)}
      </div>
    `
    : '';

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <!-- A legtöbb kliens inline stílusokat támogat, maradjunk táblás layoutnál -->
  </head>
  <body style="margin:0; padding:0; background:${brand.surface}; font-family:Manrope,'IBM Plex Sans',Arial,sans-serif; color:${brand.ink};">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 14px 40px rgba(15,23,42,.10);">
            <tr>
              <td align="center" style="padding:24px; background:${brand.header}; border-bottom:4px solid ${brand.primary};">
                <!-- ⚠️ SVG helyett PNG + e-mail safe inline stílusok -->
                <img src="${brand.logoUrl}"
                     alt="${brand.logoAlt}"
                     width="220"
                     style="display:block; outline:none; border:0; text-decoration:none; -ms-interpolation-mode:bicubic; max-width:220px; height:auto;" />
              </td>
            </tr>
            <tr>
              <td style="padding:34px 32px; font-size:15px; line-height:1.65;">
                ${brandedBody}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px; background:${brand.soft}; border-top:1px solid ${brand.primary}; font-size:12px; color:${brand.ink};">
                © ${new Date().getFullYear()} ${brand.footerName || brand.name} by EPDS. All rights reserved.<br/>
                <a href="${footerUrl}" style="color:${brand.ink};">${footerUrlLabel}</a>
                ${legalFooter}
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

function registrationEmailHtml({ firstName, lastName, loginUrl, tenantName, baseUrl }) {
  const brand = resolveEmailBrand({ tenantName, baseUrl });
  const effectiveBaseUrl = normalizeBaseUrl(tenantName, baseUrl);
  const safeLoginUrl = withBaseOrigin(effectiveBaseUrl, loginUrl, 'login');
  const portalUrl = effectiveBaseUrl;
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: `Welcome to ${brand.productName}`,
    tenantName,
    baseUrl: effectiveBaseUrl,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>Thank you for registering on the <strong>${brand.productName}</strong> platform.</p>
      <p>You can now log in and start managing your certificates and compliance documents.</p>
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Go to ${brand.productName}
        </a>
      </p>
      <p>Best regards,<br/>The ${brand.teamName}<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

function emailVerificationEmailHtml({ firstName, lastName, verifyUrl, tenantName, baseUrl }) {
  const brand = resolveEmailBrand({ tenantName, baseUrl });
  const effectiveBaseUrl = normalizeBaseUrl(tenantName, baseUrl);
  const safeVerifyUrl = withBaseOrigin(effectiveBaseUrl, verifyUrl, 'verify-email');
  const portalUrl = effectiveBaseUrl;
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'Confirm your email address',
    tenantName,
    baseUrl: effectiveBaseUrl,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>Thank you for registering on the <strong>${brand.productName}</strong> platform.</p>
      <p>Before you can sign in and start using the service, please confirm your email address.</p>
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeVerifyUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Confirm my email
        </a>
      </p>
      <p>If you did not create this account, you can safely ignore this email.</p>
      <p>Best regards,<br/>The ${brand.teamName}<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

function tenantInviteEmailHtml({ firstName, lastName, tenantName, loginUrl, password, baseUrl }) {
  const brand = resolveEmailBrand({ tenantName, baseUrl });
  const effectiveBaseUrl = normalizeBaseUrl(tenantName, baseUrl);
  const safeLoginUrl = withBaseOrigin(effectiveBaseUrl, loginUrl, 'login');
  const portalUrl = effectiveBaseUrl;
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'You have been added to a tenant',
    tenantName,
    baseUrl: effectiveBaseUrl,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName} ${lastName},</h2>
      <p>You have been added to the tenant <strong>${tenantName}</strong> on the <strong>${brand.productName}</strong> platform.</p>
      <p>You can log in using your email address${password ? ` and the password below` : ''}:</p>
      ${
        password
          ? `<p style="background:#ebebeb; padding:10px; border-radius:4px; font-family:monospace; font-size:14px; text-align:center; margin:16px 0;">${password}</p>`
          : ''
      }
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeLoginUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Log in to ${brand.productName}
        </a>
      </p>
      <p>Best regards,<br/>The ${brand.teamName}<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

function tenantJoinInviteEmailHtml({
  firstName,
  lastName,
  tenantName,
  inviterFirstName,
  inviterLastName,
  inviterEmail,
  acceptUrl,
  rejectUrl,
  baseUrl
}) {
  const brand = resolveEmailBrand({ tenantName, baseUrl });
  const effectiveBaseUrl = normalizeBaseUrl(tenantName, baseUrl);
  const safeAcceptUrl = withBaseOrigin(effectiveBaseUrl, acceptUrl, 'join-invite');
  const safeRejectUrl = withBaseOrigin(effectiveBaseUrl, rejectUrl, 'join-invite');
  const inviterName = `${inviterFirstName || ''} ${inviterLastName || ''}`.trim() || inviterEmail || 'An administrator';
  const recipientName = `${firstName || ''} ${lastName || ''}`.trim() || 'there';
  return baseTemplate({
    title: `You have been invited to join ${tenantName}`,
    tenantName,
    baseUrl: effectiveBaseUrl,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${escapeHtml(recipientName)},</h2>
      <p>
        <strong>${escapeHtml(inviterName)}</strong>
        ${inviterEmail ? `(${escapeHtml(inviterEmail)})` : ''}
        has invited you to join the <strong>${escapeHtml(tenantName)}</strong> team.
      </p>
      <p>To accept the invitation and join this team, click the button below.</p>
      <p style="margin:30px 0; text-align:center;">
        <a href="${safeAcceptUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:16px; display:inline-block;">
          Accept invitation
        </a>
      </p>
      <p>If the button does not work, open this link:<br/>
        <a href="${safeAcceptUrl}" target="_blank" rel="noopener noreferrer">${safeAcceptUrl}</a>
      </p>
      <p style="font-size:13px; color:#555;">
        Accepting this invitation will move your account from your current free personal workspace to the
        <strong>${escapeHtml(tenantName)}</strong> team.
      </p>
      <p>
        If you do not want to join, you can ignore this email or
        <a href="${safeRejectUrl}" target="_blank" rel="noopener noreferrer">reject the invitation</a>.
      </p>
      <p>Best regards,<br/>The ${brand.teamName}</p>
    `,
  });
}

function forgotPasswordEmailHtml({ firstName, lastName, loginUrl, tempPassword, tenantName, baseUrl }) {
  const brand = resolveEmailBrand({ tenantName, baseUrl });
  const effectiveBaseUrl = normalizeBaseUrl(tenantName, baseUrl);
  const safeLoginUrl = withBaseOrigin(effectiveBaseUrl, loginUrl, 'login');
  const portalUrl = effectiveBaseUrl;
  const portalUrlLabel = displayHost(portalUrl);
  return baseTemplate({
    title: 'Your temporary password',
    tenantName,
    baseUrl: effectiveBaseUrl,
    bodyHtml: `
      <h2 style="color:#131313;">Dear ${firstName || ''} ${lastName || ''},</h2>
      <p>We received a request to reset your password for <strong>${brand.productName}</strong>.</p>
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
          Go to ${brand.productName}
        </a>
      </p>
      <p>Best regards,<br/>The ${brand.teamName}<br/>
         <a href="${portalUrl}" target="_blank" rel="noopener noreferrer">${portalUrlLabel}</a>
      </p>
    `,
  });
}

/**
 * Upload completion email (HTML only)
 */
function uploadCompletedEmail(user = {}, stats = {}, tenantName) {
  const brand = resolveEmailBrand({ tenantName });
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

      <p style="margin-top:16px;">Thank you for using <strong>${brand.productName}</strong>.</p>
    `
  });
}

function certificateRequestFulfilledEmail({ firstName, lastName, certNo, request = {}, tenantName }) {
  const brand = resolveEmailBrand({ tenantName });
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
      <p>The certificate you requested is now available in <strong>${brand.productName}</strong>.</p>

      <p style="margin:16px 0 8px 0;"><strong>Uploaded certificate:</strong></p>
      <div style="background:#ebebeb; padding:10px 12px; border-radius:6px; font-family:monospace; font-size:15px;">
        ${safeUploadedCertNo || 'N/A'}
      </div>

      <p style="margin:20px 0 6px 0;"><strong>Request details</strong></p>
      <table style="width:100%; max-width:480px; margin:0 0 16px 0; border-collapse:collapse;">
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Requested cert number:</td>
          <td style="padding:6px 0; text-align:right;">${safeRequestedCertNo || '-'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Manufacturer:</td>
          <td style="padding:6px 0; text-align:right;">${safeManufacturer || '-'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0; font-weight:bold;">Model:</td>
          <td style="padding:6px 0; text-align:right;">${safeModel || '-'}</td>
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
          Go to ${brand.productName}
        </a>
      </p>

      <p>Best regards,<br/>The ${brand.teamName}<br/>
         <a href="${appUrl}" target="_blank" rel="noopener noreferrer">${appUrlLabel}</a>
      </p>
    `,
  });
}

function reportExportReadyEmail({ firstName, lastName, fileName, downloadUrl, jobId, tenantName }) {
  const brand = resolveEmailBrand({ tenantName });
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
          <td style="padding:6px 0; text-align:right;">${safeJobId || '-'}</td>
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
      <p>Best regards,<br/>The ${brand.teamName}</p>
    `
  });
}

function contributionRewardEmail({ firstName, lastName, milestone, code, expiresAt, redeemUrl, copyUrl, accountUrl }, tenantName) {
  const name = firstName || 'there';
  const safeCode = escapeHtml(code || '');
  const safeMilestone = Number(milestone) || 0;
  const expText = expiresAt instanceof Date && !isNaN(expiresAt.getTime())
    ? expiresAt.toISOString().slice(0, 10)
    : null;

  const marketingBase = EMAIL_BRANDS.atexdb.baseUrl;
  const safeRedeemUrl = withBaseOrigin(marketingBase, redeemUrl, 'billing?product=team&billingPeriod=month');
  const redeemLabel = displayHost(safeRedeemUrl);
  const safeCopyUrl = copyUrl ? withBaseOrigin(marketingBase, copyUrl) : null;
  const safeAccountUrl = withBaseOrigin(marketingBase, accountUrl, 'account');
  const accountLabel = displayHost(safeAccountUrl);

  return baseTemplate({
    title: 'Your Team discount code',
    forceBrand: 'atexdb',
    bodyHtml: `
      <h2 style="color:#131313;">Hi ${escapeHtml(name)},</h2>
      <p>Thank you for contributing to our certificate database - you have now uploaded <strong>${safeMilestone}</strong> certificates.</p>
      <p>As a thank you, here is your <strong>100% discount code for 1 month</strong> on the <strong>Team (monthly)</strong> plan (one-time use):</p>

      <div style="background:#ebebeb; padding:14px 16px; border-radius:8px; font-family:monospace; font-size:18px; text-align:center; letter-spacing:1px;">
        ${safeCode || '-'}
      </div>
      ${
        safeCopyUrl
          ? `<p style="margin:14px 0 4px 0; text-align:center;">
              <a href="${safeCopyUrl}" target="_blank" rel="noopener noreferrer"
                 style="background:#fff; border:1px solid #ddd; color:#131313; text-decoration:none; padding:10px 18px; border-radius:6px; font-size:14px; display:inline-block;">
                Copy code
              </a>
            </p>`
          : ''
      }
      ${
        expText
          ? `<p style="margin-top:10px; font-size:13px; color:#555;">This code expires on <strong>${escapeHtml(expText)}</strong>.</p>`
          : ''
      }

      <p style="margin-top:18px; margin-bottom:10px;"><strong>Team plan highlights:</strong></p>
      ${renderFeatureCards(TEAM_EMAIL_FEATURES)}

      <p style="margin:0 0 10px 0; font-size:13px; color:#555;">
        To activate: click <strong>Subscribe / Upgrade</strong>, choose <strong>Team (monthly)</strong>, then enter the promotion code at checkout if it isn’t already applied.
      </p>

      <p style="margin:22px 0; text-align:center;">
        <a href="${safeRedeemUrl}" target="_blank" rel="noopener noreferrer"
           style="background:#f8d201; color:#131313; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:16px; display:inline-block;">
          Subscribe / Upgrade (Team Monthly)
        </a>
      </p>

      <p style="margin:0;">Account: <a href="${safeAccountUrl}" target="_blank" rel="noopener noreferrer">${accountLabel}</a></p>
      <p style="margin:6px 0 0 0;">Upgrade link: <a href="${safeRedeemUrl}" target="_blank" rel="noopener noreferrer">${redeemLabel}</a></p>
      <p>Best regards,<br/>The ATEXdb Team</p>
    `
  });
}

function contributionRewardReminderEmail({ firstName, milestone, code, expiresAt, redeemUrl, finalReminder = false }, tenantName) {
  const name = escapeHtml(firstName || 'there');
  const expiry = expiresAt instanceof Date && !isNaN(expiresAt.getTime())
    ? expiresAt.toISOString().slice(0, 10)
    : '';
  const url = withBaseOrigin(EMAIL_BRANDS.atexdb.baseUrl, redeemUrl, 'billing?product=team&billingPeriod=month');
  return baseTemplate({
    title: finalReminder ? 'Your Team reward expires soon' : 'Your free Team month is waiting',
    forceBrand: 'atexdb',
    bodyHtml: `
      <h2>Hi ${name},</h2>
      <p>You earned a free month of Team after uploading <strong>${Number(milestone) || 0}</strong> certificates, but the reward has not been redeemed yet.</p>
      ${expiry ? `<p>Your code expires on <strong>${escapeHtml(expiry)}</strong>${finalReminder ? ' - redeem it before then.' : '.'}</p>` : ''}
      <div style="background:#ebebeb;padding:14px 16px;border-radius:8px;font-family:monospace;font-size:18px;text-align:center;">${escapeHtml(code || '')}</div>
      <p style="margin-top:18px;"><strong>What Team gives you:</strong></p>
      ${renderFeatureCards(TEAM_EMAIL_FEATURES)}
      <p style="margin:22px 0;text-align:center;"><a href="${url}" style="background:#f8d201;color:#131313;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;">Redeem your free month</a></p>
      <p>Best regards,<br/>The ATEXdb Team</p>
    `
  });
}

function contributionHalfwayEmail({ firstName, currentCount, milestone, uploadUrl }, tenantName) {
  const url = withBaseOrigin(EMAIL_BRANDS.atexdb.baseUrl, uploadUrl, 'cert?tab=upload');
  return baseTemplate({
    title: 'You’re halfway to your free Team month',
    forceBrand: 'atexdb',
    bodyHtml: `
      <h2>Hi ${escapeHtml(firstName || 'there')},</h2>
      <p>You’ve uploaded <strong>${Number(currentCount) || 0}</strong> certificates, so you’re halfway to your next free Team month at <strong>${Number(milestone) || 0}</strong> uploads.</p>
      <p>Every upload makes the certificate database more useful for the whole community.</p>
      <p style="margin-top:18px;"><strong>What you can unlock with Team:</strong></p>
      ${renderFeatureCards(TEAM_EMAIL_FEATURES)}
      <p style="margin:22px 0;text-align:center;"><a href="${url}" style="background:#f8d201;color:#131313;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;">Upload more certificates</a></p>
      <p>Best regards,<br/>The ATEXdb Team</p>
    `
  });
}

function automatedLifecycleEmail({ firstName, heading, paragraphs = [], bullets = [], features = [], ctaLabel, ctaUrl, ctaPath = 'account' }, tenantName) {
  const url = withBaseOrigin(EMAIL_BRANDS.atexdb.baseUrl, ctaUrl, ctaPath);
  return baseTemplate({
    title: heading,
    forceBrand: 'atexdb',
    bodyHtml: `
      <h2>Hi ${escapeHtml(firstName || 'there')},</h2>
      ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
      ${bullets.length ? `<ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      ${renderFeatureCards(features)}
      ${ctaLabel ? `<p style="margin:22px 0;text-align:center;"><a href="${url}" style="background:#f8d201;color:#131313;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;">${escapeHtml(ctaLabel)}</a></p>` : ''}
      <p>Best regards,<br/>The ATEXdb Team</p>
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
  resolveEmailBrand,
  registrationEmailHtml,
  emailVerificationEmailHtml,
  tenantInviteEmailHtml,
  tenantJoinInviteEmailHtml,
  forgotPasswordEmailHtml,
  uploadCompletedEmail,
  certificateRequestFulfilledEmail,
  reportExportReadyEmail,
  contributionRewardEmail,
  contributionRewardReminderEmail,
  contributionHalfwayEmail,
  automatedLifecycleEmail,
  ATEXDB_ACCESS_FEATURES,
  ATEXDB_START_FEATURES,
  PRO_EMAIL_FEATURES,
  TEAM_EMAIL_FEATURES,
};
