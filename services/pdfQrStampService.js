// services/pdfQrStampService.js
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

async function generateQrPngBuffer(text, opts = {}) {
  const { margin = 1, scale = 6, errorCorrectionLevel = 'M' } = opts;
  return QRCode.toBuffer(String(text || ''), {
    type: 'png',
    margin,
    scale,
    errorCorrectionLevel
  });
}

function wrapTextToWidth(font, text, fontSize, maxWidth) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function computeAnchoredBox({ pageWidth, pageHeight, position, marginX, marginY, boxWidth, boxHeight }) {
  const mx = Math.max(0, Number(marginX || 0));
  const my = Math.max(0, Number(marginY || 0));
  const w = Math.max(1, Number(boxWidth || 1));
  const h = Math.max(1, Number(boxHeight || 1));

  if (position === 'bottom-left') {
    return { x: mx, y: my };
  }
  if (position === 'top-left') {
    return { x: mx, y: Math.max(0, pageHeight - my - h) };
  }
  if (position === 'top-right') {
    return { x: Math.max(0, pageWidth - mx - w), y: Math.max(0, pageHeight - my - h) };
  }
  // bottom-right
  return { x: Math.max(0, pageWidth - mx - w), y: my };
}

/**
 * Stamp a QR code onto each page of a PDF.
 * @param {Buffer} pdfBuffer
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.size=96] QR size in PDF points
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [opts.position='bottom-right']
 * @param {number} [opts.marginX=18] distance from left/right edge
 * @param {number} [opts.marginY=18] distance from bottom/top edge
 * @param {number} [opts.x] absolute X override (PDF points)
 * @param {number} [opts.y] absolute Y override (PDF points)
 * @param {boolean} [opts.addLabel=true] add small URL label under QR
 * @param {string} [opts.warningText] small warning text under the label
 * @param {number} [opts.labelFontSize=8] font size for label + warning text
 * @param {object} [opts.signatureWatermark]
 * @param {boolean} [opts.signatureWatermark.enabled=false]
 * @param {string} [opts.signatureWatermark.text]
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [opts.signatureWatermark.position='bottom-right']
 * @param {number} [opts.signatureWatermark.marginX=36]
 * @param {number} [opts.signatureWatermark.marginY=72]
 * @param {number} [opts.signatureWatermark.maxWidth=260]
 * @param {number} [opts.signatureWatermark.fontSize=9]
 * @param {number} [opts.signatureWatermark.opacity=0.25]
 * @param {number} [opts.signatureWatermark.rotateDeg=-18]
 * @returns {Promise<Buffer>}
 */
async function stampPdfWithQr(pdfBuffer, url, opts = {}) {
  const {
    size = 96,
    position = 'bottom-right',
    marginX = 18,
    marginY = 18,
    x: xOverride,
    y: yOverride,
    addLabel = true,
    warningText,
    labelFontSize = 8,
    signatureWatermark
  } = opts;
  const png = await generateQrPngBuffer(url);

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const img = await pdfDoc.embedPng(png);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    let x = 0;
    let y = 0;
    if (Number.isFinite(xOverride) && Number.isFinite(yOverride)) {
      x = Number(xOverride);
      y = Number(yOverride);
    } else {
      ({ x, y } = computeAnchoredBox({
        pageWidth: width,
        pageHeight: height,
        position,
        marginX,
        marginY,
        boxWidth: size,
        boxHeight: size
      }));
    }

    page.drawImage(img, { x, y, width: size, height: size, opacity: 1 });

    if (addLabel) {
      const label = 'Verify';
      const warn =
        String(warningText || '').trim() ||
        'Amennyiben az adatok eltérnek, az adatokat kompromittálhatták, egyeztessen a szolgáltatóval.';

      const fontSize = Math.max(6, Math.min(Number(labelFontSize || 8), 16));
      const labelY = Math.max(0, y - 12);
      page.drawText(label, {
        x,
        y: labelY,
        size: fontSize,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1)
      });

      const maxWidth = 220; // keep it compact; avoid overlapping signature blocks
      const lines = wrapTextToWidth(fontRegular, warn, fontSize, maxWidth);
      let yy = Math.max(0, labelY - (fontSize + 2));
      for (const line of lines) {
        if (yy <= 0) break;
        page.drawText(line, {
          x,
          y: yy,
          size: fontSize,
          font: fontRegular,
          color: rgb(0.1, 0.1, 0.1)
        });
        yy -= fontSize + 2;
      }
    }

    if (signatureWatermark?.enabled && String(signatureWatermark?.text || '').trim()) {
      const wmText = String(signatureWatermark.text).trim();
      const wmFontSize = Number(signatureWatermark.fontSize || 9);
      const wmOpacity = Number(signatureWatermark.opacity ?? 0.25);
      const wmRotateDeg = Number(signatureWatermark.rotateDeg ?? -18);
      const wmMaxWidth = Number(signatureWatermark.maxWidth || 260);
      const wmPosition = signatureWatermark.position || 'bottom-right';
      const wmMarginX = Number(signatureWatermark.marginX ?? 36);
      const wmMarginY = Number(signatureWatermark.marginY ?? 72);

      const lineHeight = wmFontSize + 2;
      const wmLines = wrapTextToWidth(fontRegular, wmText, wmFontSize, wmMaxWidth);
      const boxHeight = Math.max(1, wmLines.length * lineHeight);

      const { x: wx, y: wy } = computeAnchoredBox({
        pageWidth: width,
        pageHeight: height,
        position: wmPosition,
        marginX: wmMarginX,
        marginY: wmMarginY,
        boxWidth: wmMaxWidth,
        boxHeight
      });

      // Draw from top line down, anchored within the box.
      let ty = wy + (wmLines.length - 1) * lineHeight;
      for (const line of wmLines) {
        page.drawText(line, {
          x: wx,
          y: ty,
          size: wmFontSize,
          font: fontRegular,
          color: rgb(0.05, 0.05, 0.05),
          opacity: Number.isFinite(wmOpacity) ? Math.min(1, Math.max(0.05, wmOpacity)) : 0.25,
          rotate: degrees(Number.isFinite(wmRotateDeg) ? wmRotateDeg : -18)
        });
        ty -= lineHeight;
      }
    }
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = {
  stampPdfWithQr
};
