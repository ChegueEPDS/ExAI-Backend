const FormData = require('form-data');
const axios = require('axios');
const logger = require('../config/logger');

function getAuthHeaders() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
}

async function handleUploadChatFile(req, res) {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: 'Nem érkezett fájl a kérésben.' });
    }

    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', file.buffer, {
      filename: file.originalname || 'upload',
      contentType: file.mimetype || 'application/octet-stream',
    });

    const uploadRes = await axios.post('https://api.openai.com/v1/files', form, {
      headers: { ...getAuthHeaders(), ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 120_000,
    });

    return res.status(201).json({
      ok: true,
      fileId: uploadRes.data?.id,
      filename: file.originalname || uploadRes.data?.filename || 'upload',
      bytes: file.size || uploadRes.data?.bytes || null,
      purpose: uploadRes.data?.purpose || 'user_data',
    });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    const upstreamMessage = err?.response?.data?.error?.message;
    logger.error('openai.chat_file.upload failed', {
      message: err?.message || String(err),
      status,
      data: err?.response?.data || null,
    });
    return res.status(status).json({
      ok: false,
      error: upstreamMessage || err?.message || 'Nem sikerült feltölteni a fájlt.',
    });
  }
}

module.exports = { handleUploadChatFile };
