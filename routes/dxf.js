// routes/dxf.js
const express = require('express');
const multer = require('multer');
const { Agent } = require('undici');

const router = express.Router();

// Multer memóriába (50 MB példa)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function buildFunctionUrl(path = "/api/process_dxf") {
  const base = process.env.DXF_FUNC_URL;   // pl. https://<app>.azurewebsites.net vagy lokál root
  const code = process.env.DXF_FUNC_CODE;  // opcionális function key

  // Root URL (ne az endpoint legyen beégetve)
  const root = new URL(base || "http://localhost:7071");
  const u = new URL(path, root);           // pl. /api/process_dxf/start

  // ha nincs code= a query-ben, de van DXF_FUNC_CODE, fűzzük hozzá
  if (code && !u.searchParams.has('code')) {
    u.searchParams.set('code', code);
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[dxf] Using Functions URL: ${u.toString()}`);
  }
  return u.toString();
}

const keepAliveAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000
});

router.post('/upload', upload.single('file'), async (req, res) => {
  req.setTimeout(300_000); // 5 perc
  res.setTimeout(300_000);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Hiányzik a "file" mező.' });
    }

    const url = buildFunctionUrl();

    // natív FormData/Blob (Node 18+)
    const form = new FormData();
    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype || 'application/octet-stream'
    });
    form.append('file', blob, req.file.originalname || 'upload.dxf');

    // 240s fetch timeout (Functions Consumption kb. 230s körül vág)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);

    const resp = await fetch(url, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      dispatcher: keepAliveAgent
    }).finally(() => clearTimeout(timer));

    const text = await resp.text();

    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: (json && (json.error || json.message)) || text || 'Azure Function hiba',
        status: resp.status
      });
    }

    if (!json) {
      return res.status(502).json({ error: 'Invalid JSON from Azure Function', raw: text });
    }

    return res.json(json);
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return res.status(502).json({
      error: isAbort ? 'Azure Function request timeout' : 'DXF proxy hiba',
      detail: String(err?.message || err)
    });
  }
});

// --- Async DXF pipeline proxy -------------------------------------------------

// 1) Start: fájl feltöltése a Functions async start végpontjára → jobId-t adunk vissza
router.post('/start', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Hiányzik a "file" mező.' });

    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    form.append('file', blob, req.file.originalname || 'upload.dxf');

    const url = buildFunctionUrl('/api/process_dxf/start');

    const resp = await fetch(url, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      dispatcher: keepAliveAgent
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);

    const jobId = data.job_id;
    return res.status(202).json({
      jobId,
      statusUrl: `/api/dxf/status/${jobId}`,
      resultUrl: `/api/dxf/result/${jobId}`
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Start failed', detail: String(err?.message || err) });
  }
});

// 2) Status: állapot lekérdezése a Functions /status végpontjáról
router.get('/status/:jobId', async (req, res) => {
  try {
    const base = buildFunctionUrl('/api/process_dxf/status');
    const u = new URL(base);
    u.searchParams.set('job_id', req.params.jobId);

    const resp = await fetch(u.toString(), {
      headers: { Accept: 'application/json' },
      dispatcher: keepAliveAgent
    });

    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Status failed', detail: String(err?.message || err) });
  }
});

// 3) Result: kész eredmény (JSON) proxyzása
router.get('/result/:jobId', async (req, res) => {
  try {
    const base = buildFunctionUrl('/api/process_dxf/result');
    const u = new URL(base);
    u.searchParams.set('job_id', req.params.jobId);

    const resp = await fetch(u.toString(), {
      headers: { Accept: 'application/json' },
      dispatcher: keepAliveAgent
    });

    if (resp.status === 409) {
      const j = await resp.json();
      return res.status(409).json(j);
    }

    const text = await resp.text();
    res.status(resp.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(text);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Result failed', detail: String(err?.message || err) });
  }
});

module.exports = router;