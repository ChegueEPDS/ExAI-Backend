const path = require('path');
const fs = require('fs');

function resolveYearbook2026Path() {
  return path.join(__dirname, '..', 'storage', 'Ex Compliance Engineering Yearbook 2026.pdf');
}

exports.downloadYearbook2026 = async (req, res) => {
  try {
    const userId = req.user?.id || req.userId || req.scope?.userId || null;
    console.log('[download] yearbook-2026 request start', { userId, ip: req.ip });

    const filePath = resolveYearbook2026Path();
    await fs.promises.access(filePath, fs.constants.R_OK);

    // Always force download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');

    res.on('finish', () => {
      console.log('[download] yearbook-2026 response finished', { userId });
    });
    res.on('close', () => {
      console.log('[download] yearbook-2026 response closed', { userId });
    });

    return res.download(filePath, 'Ex Compliance Engineering Yearbook 2026.pdf', (err) => {
      if (!err) return;
      console.warn('[download] yearbook-2026 download failed', {
        userId,
        code: err.code,
        message: err.message
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      } else {
        try { res.end(); } catch {}
      }
    });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('downloadYearbook2026 error:', err);
    return res.status(500).json({ error: 'Failed to download file' });
  }
};
