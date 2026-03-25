// services/pdfSigningService.js
const fs = require('fs');

const { PDFDocument } = require('pdf-lib');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { SUBFILTER_ADOBE_PKCS7_DETACHED } = require('@signpdf/utils');

function readP12FromEnvOrPath() {
  const base64 = String(process.env.ROT_PDF_SIGN_P12_BASE64 || '').trim();
  if (base64) {
    return Buffer.from(base64, 'base64');
  }
  const p12Path = String(process.env.ROT_PDF_SIGN_P12_PATH || '').trim();
  if (!p12Path) return null;
  return fs.readFileSync(p12Path);
}

function isSigningEnabled() {
  return String(process.env.ROT_PDF_SIGN_ENABLED || '').trim().toLowerCase() === 'true';
}

async function signPdfBuffer(pdfBuffer, opts = {}) {
  if (!isSigningEnabled()) return pdfBuffer;

  const passphrase = String(process.env.ROT_PDF_SIGN_P12_PASSWORD || '').trim();
  if (!passphrase) throw new Error('ROT_PDF_SIGN_P12_PASSWORD is required when ROT_PDF_SIGN_ENABLED=true');

  const p12 = readP12FromEnvOrPath();
  if (!p12 || !p12.length) throw new Error('Signing P12 not found. Set ROT_PDF_SIGN_P12_BASE64 or ROT_PDF_SIGN_P12_PATH.');

  const reason = String(opts.reason || process.env.ROT_PDF_SIGN_REASON || '').trim();
  const location = String(opts.location || process.env.ROT_PDF_SIGN_LOCATION || '').trim();
  const contactInfo = String(opts.contactInfo || process.env.ROT_PDF_SIGN_CONTACT || '').trim();
  const name = String(opts.name || process.env.ROT_PDF_SIGN_NAME || '').trim();

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  pdflibAddPlaceholder({
    pdfDoc,
    // placeholder-pdf-lib expects actual strings (not undefined)
    reason: reason || '',
    location: location || '',
    contactInfo: contactInfo || '',
    name: name || '',
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
  });
  const pdfWithPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  const signer = new P12Signer(p12, { passphrase });
  const signPdf = new SignPdf();
  const signed = await signPdf.sign(pdfWithPlaceholder, signer);
  return Buffer.isBuffer(signed) ? signed : Buffer.from(signed);
}

module.exports = {
  signPdfBuffer,
  isSigningEnabled,
};
