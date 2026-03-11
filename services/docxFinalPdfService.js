// services/docxFinalPdfService.js
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} exited with ${code}. ${stderr || stdout}`.trim());
      err.code = code;
      err.stderr = stderr;
      err.stdout = stdout;
      reject(err);
    });
  });
}

async function which(cmd) {
  try {
    const { stdout } = await run('bash', ['-lc', `command -v ${cmd}`]);
    const p = String(stdout || '').trim();
    return p || null;
  } catch {
    return null;
  }
}

async function ensureTooling() {
  const soffice = (await which('soffice')) || (await which('libreoffice'));
  const pdftoppm = await which('pdftoppm');
  if (!soffice) {
    throw new Error(
      'DOCX→PDF conversion requires LibreOffice (soffice). Install it on the server and ensure "soffice" is in PATH.'
    );
  }
  if (!pdftoppm) {
    throw new Error(
      'PDF rasterization requires poppler-utils (pdftoppm). Install it on the server and ensure "pdftoppm" is in PATH.'
    );
  }
  return { soffice, pdftoppm };
}

function sortPpmPngs(files, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)\\.png$`);
  return files
    .map((f) => {
      const m = f.match(re);
      return { f, n: m ? Number(m[1]) : 0 };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.f);
}

/**
 * Convert a list of DOCX buffers into a single "image-only" PDF.
 * Uses LibreOffice for DOCX→PDF, then pdftoppm for PDF→PNG, then pdf-lib to assemble.
 *
 * @param {Array<{fileName: string, buffer: Buffer}>} docxItems
 * @param {object} opts
 * @param {number} [opts.dpi=200]
 * @returns {Promise<Buffer>}
 */
async function buildFinalImagePdfFromDocx(docxItems, opts = {}) {
  const { dpi = 200 } = opts;
  if (!Array.isArray(docxItems) || !docxItems.length) throw new Error('No DOCX items provided');
  const { soffice, pdftoppm } = await ensureTooling();

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-final-'));
  const outPdf = await PDFDocument.create();
  try {
    for (let i = 0; i < docxItems.length; i++) {
      const it = docxItems[i];
      const base = `doc_${String(i + 1).padStart(4, '0')}`;
      const docxPath = path.join(tmpRoot, `${base}.docx`);
      await fs.writeFile(docxPath, it.buffer);

      // LibreOffice conversion output will be `${base}.pdf` in tmpRoot.
      await run(soffice, ['--headless', '--nologo', '--nolockcheck', '--nodefault', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', tmpRoot, docxPath], {
        cwd: tmpRoot
      });

      const pdfPath = path.join(tmpRoot, `${base}.pdf`);
      if (!(await pathExists(pdfPath))) {
        throw new Error(`LibreOffice did not produce expected PDF: ${pdfPath}`);
      }

      const prefix = `ppm_${base}`;
      const outPrefix = path.join(tmpRoot, prefix);
      await run(pdftoppm, ['-png', '-r', String(dpi), pdfPath, outPrefix], { cwd: tmpRoot });

      const files = await fs.readdir(tmpRoot);
      const pngNames = sortPpmPngs(files, prefix);
      if (!pngNames.length) throw new Error('pdftoppm did not produce any PNG pages');

      for (const pngName of pngNames) {
        const pngPath = path.join(tmpRoot, pngName);
        const pngBytes = await fs.readFile(pngPath);
        const img = await outPdf.embedPng(pngBytes);
        const { width, height } = img.scale(1);
        const page = outPdf.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }
    }

    const bytes = await outPdf.save();
    return Buffer.from(bytes);
  } finally {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  buildFinalImagePdfFromDocx
};

