// controllers/dxfController.js
const fs = require('fs');
const { Agent } = require('undici');
const owners = require('../lib/notifications/owners');
const bus = require('../lib/notifications/bus');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { uploadBuffer, getReadSasUrl, deletePrefix, deleteFile } = require('../services/azureBlobService');
const authSse = require('../middlewares/authSse'); // csak típus/komment okból
const DxfJob = require('../models/DxfJob');

// --- blob path helpers ---
function toBlobPath(input) {
  if (!input) return null;
  let u = String(input);

  // strip query (SAS, etc.)
  const q = u.indexOf('?');
  if (q !== -1) u = u.slice(0, q);

  // If it's a full URL, extract path AFTER container name
  try {
    const url = new URL(u);
    const parts = (url.pathname || '').split('/').filter(Boolean); // ['container','folder','file.ext']
    if (parts.length >= 2) {
      return decodeURIComponent(parts.slice(1).join('/')); // 'folder/file.ext'
    }
    return null;
  } catch {
    // Not a URL: assume it's already a container-relative path. Just trim leading slashes.
    return u.replace(/^\/+/, '');
  }
}

// --- debug helpers ---
function dbg(...args) { try { console.log('[dxf]', ...args); } catch {} }
function hasAuthHeader(req) {
  const h = req?.headers || {};
  const a = h['authorization'] || h['Authorization'];
  return !!a;
}

// -------- infra helpers --------
const keepAliveAgent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 });

function pickFunctionCode(path = "") {
  const p = String(path);
  if (p.includes('/process_dxf/start')) return process.env.DXF_FUNC_CODE_START || process.env.DXF_FUNC_CODE;
  if (p.includes('/process_dxf/status')) return process.env.DXF_FUNC_CODE_STATUS || process.env.DXF_FUNC_CODE;
  if (p.includes('/process_dxf/result')) return process.env.DXF_FUNC_CODE_RESULT || process.env.DXF_FUNC_CODE;
  if (p.endsWith('/process_dxf') || p.includes('/process_dxf?')) return process.env.DXF_FUNC_CODE_SYNC || process.env.DXF_FUNC_CODE;
  return process.env.DXF_FUNC_CODE;
}

function buildFunctionUrl(path = "/api/process_dxf") {
  const base = process.env.DXF_FUNC_URL;
  const root = new URL(base || "http://localhost:7071");
  const u = new URL(path, root);
  const code = pickFunctionCode(path);
  if (code && !u.searchParams.has('code')) u.searchParams.set('code', code);
  if (process.env.NODE_ENV !== 'production') console.log(`[dxf] Using Functions URL: ${u.toString()}`);
  return u.toString();
}

function isAllowedFile(file) {
  if (!file) return false;
  const name = String(file.originalname || '').toLowerCase();
  const type = String(file.mimetype || '').toLowerCase();
  if (name.endsWith('.dxf') || name.endsWith('.dwg')) return true;
  if (type.includes('dxf') || type.includes('dwg') || type === 'application/acad' || type === 'image/vnd.dwg') return true;
  return type === 'application/octet-stream' && typeof file.size === 'number' && file.size > 0;
}

async function fetchWithRetry(url, options = {}, { retries = 2, baseDelay = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 240_000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: controller.signal, dispatcher: options.dispatcher || keepAliveAgent });
      clearTimeout(t);
      return resp;
    } catch (e) {
      lastErr = e;
      const transient = e?.name === 'AbortError' || e?.code === 'ECONNRESET' || e?.code === 'EAI_AGAIN' || e?.code === 'UND_ERR_CONNECT_TIMEOUT';
      if (!transient || attempt === retries) throw e;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

async function fetchJsonRet(url, options = {}, retryOpts) {
  const resp = await fetchWithRetry(url, options, retryOpts);
  const text = await resp.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { resp, text, json };
}

function mapStatus(s) {
  if (!s) return null;
  const n = String(s).toLowerCase();
  if (n === 'queued') return 'queued';
  if (n === 'running' || n === 'processing') return 'running';
  if (n === 'done' || n === 'succeeded' || n === 'completed') return 'succeeded';
  if (n === 'failed' || n === 'error') return 'failed';
  return null;
}

function getUserId(req) {
  return (
    req.user?.id ||
    req.userId ||
    req.auth?.sub ||
    req.headers['x-user-id'] ||
    'anonymous'
  );
}

function isAdmin(req) {
  try {
    const u = req.user || {};
    return u.role === 'admin' || u.isAdmin === true;
  } catch {
    return false;
  }
}

// -------- tracker (poll + push + persist) --------
const trackers = new Map();

function startTracker(jobId) {
  if (trackers.has(jobId)) return trackers.get(jobId);
  const pollMin = 1500, pollMax = 8000, jitter = 400;
  const t = { jobId, stopped: false, timer: null };

  async function tick(delay = pollMin) {
    if (t.stopped) return;
    clearTimeout(t.timer);
    try {
      // status
      const su = new URL(buildFunctionUrl('/api/process_dxf/status'));
      su.searchParams.set('job_id', jobId);
      const { resp: sResp, json: sJson } = await fetchJsonRet(su.toString(), {
        headers: { Accept: 'application/json', Connection: 'close' },
        timeoutMs: 45_000
      }, { retries: 1, baseDelay: 400 });

      if (sResp.ok && sJson?.status) {
        dbg('poll status', { jobId, http: sResp?.status, status: sJson?.status });
        const userId = owners.get(jobId) || 'anonymous';
        bus.emitTo(userId, 'dxf:status', { jobId, status: sJson.status });
        const dbStatus = mapStatus(sJson.status);
        if (dbStatus) {
          try { await DxfJob.updateOne({ job_id: jobId }, { $set: { status: dbStatus } }); } catch (e) {}
        }
      }

      // result
      const ru = new URL(buildFunctionUrl('/api/process_dxf/result'));
      ru.searchParams.set('job_id', jobId);
      const rResp = await fetchWithRetry(ru.toString(), {
        headers: { Accept: 'application/json', Connection: 'close' },
        timeoutMs: 60_000
      }, { retries: 1, baseDelay: 600 });

      dbg('poll result resp', { jobId, http: rResp?.status });

      if (rResp.status === 409) {
        const next = Math.min(pollMax, Math.round(delay * 1.4)) + (Math.random()*jitter|0);
        dbg('result not ready yet', { jobId, nextDelay: next });
        t.timer = setTimeout(() => tick(next), next);
        return;
      }

      const rText = await rResp.text();
      let data; try { data = rText ? JSON.parse(rText) : undefined; } catch { data = undefined; }
      if (!rResp.ok || !data) {
        const userId = owners.get(jobId) || 'anonymous';
        const msg = (data?.error || rText || 'Azure Function hiba');
        bus.emitTo(userId, 'dxf:error', { jobId, message: msg });
        try {
          await DxfJob.updateOne(
            { job_id: jobId },
            { $set: { status: 'failed', finished_at: new Date(), error_message: msg } }
          );
        } catch {}
        dbg('result endpoint error', { jobId, http: rResp?.status, bodyLen: (rText && rText.length) || 0 });
        try { await notifyAndStore(userId, { type: 'dxf-failed', title: 'DXF feldolgozás sikertelen', message: msg, data: { jobId } }); } catch {}
        stopTracker(jobId);
        return;
      }

      // persist blobs (result REQUIRED, svg OPTIONAL)
      let resultUrl = null, svgUrl = null;
      try {
        const jsonBuf = Buffer.from(JSON.stringify(data), 'utf8');
        resultUrl = await uploadBuffer(`dxf/${jobId}/result.json`, jsonBuf, 'application/json');
        dbg('result blob uploaded', { jobId, target: `dxf/${jobId}/result.json`, resultUrl, bytes: jsonBuf.length });
      } catch (e) {
        console.warn('[dxf] result upload failed:', e?.message || e);
      }

      if (!resultUrl) {
        const userId = owners.get(jobId) || 'anonymous';
        const msg = 'Failed to upload result to blob';
        bus.emitTo(userId, 'dxf:error', { jobId, message: msg });
        try {
          await DxfJob.updateOne(
            { job_id: jobId },
            { $set: { status: 'failed', finished_at: new Date(), error_message: msg } }
          );
        } catch {}
        try { await notifyAndStore(userId, { type: 'dxf-failed', title: 'DXF feldolgozás sikertelen', message: msg, data: { jobId } }); } catch {}
        stopTracker(jobId);
        return;
      }

      if (data?.dxfSvg && typeof data.dxfSvg === 'string') {
        try {
          const svgBuf = Buffer.from(data.dxfSvg,'utf8');
          svgUrl = await uploadBuffer(`dxf/${jobId}/svg.svg`, svgBuf, 'image/svg+xml');
          dbg('svg blob uploaded', { jobId, target: `dxf/${jobId}/svg.svg`, svgUrl, bytes: svgBuf.length });
        } catch (e) {
          console.warn('[dxf] svg upload failed (continuing):', e?.message || e);
        }
      }

      // Convert URLs to container-relative paths
      const resultPath = toBlobPath(resultUrl);
      const svgPath = toBlobPath(svgUrl);

      // update DB success
      try {
        const pipeCount    = Array.isArray(data?.pipes) ? data.pipes.length : undefined;
        const groupCount   = Array.isArray(data?.pipe_groups) ? data.pipe_groups.length : undefined;
        const fittingCount = Array.isArray(data?.fittings) ? data.fittings.length : undefined;
        await DxfJob.updateOne(
          { job_id: jobId },
          { $set: { status: 'succeeded', finished_at: new Date(), result_blob_url: resultPath, svg_blob_url: svgPath, pipe_count: pipeCount, group_count: groupCount, fitting_count: fittingCount } }
        );
        dbg('db updated success', { jobId, resultUrl, svgUrl, counts: { pipes: pipeCount, groups: groupCount, fittings: fittingCount } });
      } catch {}

      // Generate short-lived SAS URLs for push-only payload
      let resultSas = null, svgSas = null;
      try {
        if (resultPath) {
          resultSas = await getReadSasUrl(resultPath, {
            ttlSeconds: 900,
            filename: `${jobId}.json`,
            contentType: 'application/json'
          });
        }
        if (svgPath) {
          svgSas = await getReadSasUrl(svgPath, {
            ttlSeconds: 900,
            filename: `${jobId}.svg`,
            contentType: 'image/svg+xml'
          });
        }
        dbg('sas generated', { jobId, hasResult: !!resultSas, hasSvg: !!svgSas });
      } catch (e) {
        console.warn('[dxf] SAS gen failed:', e?.message || e);
      }

      const userId = owners.get(jobId) || 'anonymous';
      bus.emitTo(userId, 'dxf:done', {
        jobId,
        result: data,
        blobs: {
          path: { result: resultPath, svg: svgPath },
          sas:  { result: resultSas,  svg: svgSas  }
        }
      });
      try {
        await notifyAndStore(userId, {
          type: 'dxf-done',
          title: 'DXF feldolgozás kész',
          message: data?.source?.filename || 'A feldolgozás befejeződött',
          data: { jobId, blobs: { result: resultPath, svg: svgPath } },
          meta: { route: '/dxf/view', query: { jobId } }
        });
      } catch {}
      dbg('done notification sent', { jobId, userId });
      stopTracker(jobId);
    } catch (e) {
      console.warn('[dxf] tick error:', e?.message || e);
      const next = Math.min(pollMax, Math.round(delay * 1.6)) + (Math.random()*jitter|0);
      dbg('tick schedule retry', { jobId, nextDelay: next });
      t.timer = setTimeout(() => tick(next), next);
    }
  }

  function stopTracker(id = jobId) {
    const tt = trackers.get(id);
    if (!tt) return;
    tt.stopped = true;
    clearTimeout(tt.timer);
    trackers.delete(id);
  }

  t.timer = setTimeout(() => tick(pollMin), 0);
  trackers.set(jobId, t);
  return t;
}

function stopTracker(jobId) {
  const t = trackers.get(jobId);
  if (!t) return;
  t.stopped = true;
  clearTimeout(t.timer);
  trackers.delete(jobId);
}

// -------- controller handlers --------
exports.uploadSync = async (req, res) => {
  req.setTimeout(300_000); res.setTimeout(300_000);
  dbg('uploadSync start', {
    hasAuth: hasAuthHeader(req),
    userId: req.userId || req.user?.id || null,
    file: req.file ? { name: req.file.originalname, size: req.file.size, type: req.file.mimetype } : null
  });
  try {
    if (!req.file) return res.status(400).json({ error: 'Hiányzik a \"file\" mező.' });
    if (!isAllowedFile(req.file)) return res.status(400).json({ error: 'Csak .dxf vagy .dwg fájl engedélyezett.' });

    const url = buildFunctionUrl();
    const fileBuf = await fs.promises.readFile(req.file.path);
    const form = new FormData();
    form.append(
      'file',
      new (global.Blob || require('buffer').Blob)([fileBuf], { type: req.file.mimetype || 'application/octet-stream' }),
      req.file.originalname || 'upload.dxf'
    );

    const { resp, text, json } = await fetchJsonRet(url, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      timeoutMs: 240_000,
      dispatcher: keepAliveAgent
    }, { retries: 2, baseDelay: 700 });

    if (!resp.ok || !json) return res.status(resp.status || 502).json({ error: (json?.error || json?.message) || text || 'Azure Function hiba', status: resp.status });
    dbg('uploadSync success', { status: resp.status, bytes: fileBuf?.length || null });
    return res.json(json);
  } catch (err) {
    dbg('uploadSync error', { err: String(err?.message || err) });
    const isAbort = err?.name === 'AbortError';
    return res.status(502).json({ error: isAbort ? 'Azure Function request timeout' : 'DXF proxy hiba', detail: String(err?.message || err) });
  }
};

exports.startAsync = async (req, res) => {
  try {
    dbg('startAsync start', {
      hasAuth: hasAuthHeader(req),
      userId: req.userId || req.user?.id || req.auth?.sub || req.headers['x-user-id'] || null,
      file: req.file ? { name: req.file.originalname, size: req.file.size, type: req.file.mimetype } : null
    });

    if (!req.file) return res.status(400).json({ error: 'Hiányzik a \"file\" mező.' });
    if (!isAllowedFile(req.file)) return res.status(400).json({ error: 'Csak .dxf vagy .dwg fájl engedélyezett.' });

    const url = buildFunctionUrl('/api/process_dxf/start');
    const fileBuf = await fs.promises.readFile(req.file.path);
    const form = new FormData();
    form.append(
      'file',
      new (global.Blob || require('buffer').Blob)([fileBuf], { type: req.file.mimetype || 'application/octet-stream' }),
      req.file.originalname || 'upload.dxf'
    );

    const { resp, text, json } = await fetchJsonRet(url, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      timeoutMs: 240_000,
      dispatcher: keepAliveAgent
    }, { retries: 2, baseDelay: 700 });

    dbg('startAsync function resp', { status: resp.status, ok: resp.ok, hasJson: !!json, textLen: (text && text.length) || 0 });

    if (!resp.ok || !json) return res.status(resp.status || 502).json({
      error: (json && (json.error || json.message)) || text || 'Azure Function hiba',
      status: resp.status
    });

    const jobId = json.job_id;
    const userId = getUserId(req);
    const ownerCompany = (req.user && (req.user.company || req.user.org || req.user.tenant)) || null;
    dbg('startAsync identified owner', { jobId, userId, ownerCompany });

    // raw file → blob
    let rawUrl = null;
    try {
      const ext = (req.file.originalname || '').toLowerCase().endsWith('.dwg') ? 'dwg' : 'dxf';
      const rawCt = req.file.mimetype || 'application/dxf';
      rawUrl = await uploadBuffer(`dxf/${jobId}/raw.${ext}`, fileBuf, rawCt);
      dbg('raw blob uploaded', { jobId, target: `dxf/${jobId}/raw.${ext}`, rawUrl, rawPath: toBlobPath(rawUrl), bytes: fileBuf?.length || null, ct: rawCt });
    } catch (e) {
      console.warn('[dxf] raw upload failed:', e?.message || e);
    }

    // Convert rawUrl to container-relative path
    const rawPath = toBlobPath(rawUrl);

    // DB record
    try {
      await DxfJob.create({
        job_id: jobId,
        filename: req.file.originalname || 'upload.dxf',
        size_bytes: typeof req.file.size === 'number' ? req.file.size : undefined,
        content_type: req.file.mimetype || 'application/dxf',

        // owner info for filtering/history
        owner_user_id: userId || null,
        owner_company: ownerCompany,

        status: 'queued',
        raw_blob_url: rawPath,
        version: 1
      });
    } catch (e) { console.warn('[dxf] DxfJob create failed:', e?.message || e); }

    owners.set(jobId, userId);
    startTracker(jobId);
    dbg('job created', { jobId, userId, ownerCompany });

    // NINCS start notification — csak DONE/ERROR

    return res.status(202).json({ jobId, statusUrl: `/api/dxf/status/${jobId}`, resultUrl: `/api/dxf/result/${jobId}` });
  } catch (err) {
    dbg('startAsync error', { err: String(err?.message || err) });
    return res.status(502).json({ error: 'Start failed', detail: String(err?.message || err) });
  }
};

exports.status = async (req, res) => {
  try {
    const base = buildFunctionUrl('/api/process_dxf/status');
    const u = new URL(base); u.searchParams.set('job_id', req.params.jobId);
    const { resp, text, json } = await fetchJsonRet(u.toString(), {
      headers: { Accept: 'application/json' }, timeoutMs: 60_000, dispatcher: keepAliveAgent
    }, { retries: 2, baseDelay: 500 });
    dbg('status proxy resp', { jobId: req.params.jobId, http: resp?.status, hasJson: !!json });
    if (!resp.ok || !json) return res.status(resp.status || 502).json({ error: (json?.error || json?.message) || text || 'Azure Function hiba', status: resp.status });
    return res.status(resp.status).json(json);
  } catch (err) {
    dbg('status proxy error', { jobId: req.params.jobId, err: String(err?.message || err) });
    return res.status(502).json({ error: 'Status failed', detail: String(err?.message || err) });
  }
};

exports.result = async (req, res) => {
  try {
    const base = buildFunctionUrl('/api/process_dxf/result');
    const u = new URL(base); u.searchParams.set('job_id', req.params.jobId);
    const resp = await fetchWithRetry(u.toString(), { headers: { Accept: 'application/json' }, timeoutMs: 120_000, dispatcher: keepAliveAgent }, { retries: 2, baseDelay: 500 });

    dbg('result proxy http', { jobId: req.params.jobId, http: resp?.status });

    if (resp.status === 409) {
      const t = await resp.text(); let j; try { j = t ? JSON.parse(t) : undefined; } catch { j = undefined; }
      return res.status(409).json(j || { status: 'queued' });
    }

    const text = await resp.text(); let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!resp.ok || !data) return res.status(resp.status || 502).json({ error: (data?.error || data?.message) || text || 'Azure Function hiba', status: resp.status });

    dbg('result proxy success', { jobId: req.params.jobId, keys: Object.keys(data || {}) });
    return res.json(data);
  } catch (err) {
    dbg('result proxy error', { jobId: req.params.jobId, err: String(err?.message || err) });
    return res.status(502).json({ error: 'Result failed', detail: String(err?.message || err) });
  }
};

exports.stream = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const userId = getUserId(req);
  const jobId  = req.params.jobId;
  dbg('stream open', { jobId, userId });

  try { startTracker(jobId); } catch {}

  res.write(`event: hello\n`);
  res.write(`data: ${JSON.stringify({ jobId, userId })}\n\n`);
  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);

  const channel = `notify:${userId}`;
  const listener = (msg) => {
    const { event, payload } = msg || {};
    if (!payload) return;
    if ((event === 'dxf:status' || event === 'dxf:done' || event === 'dxf:error') && payload.jobId === jobId) {
      res.write(`event: ${event.replace(':','-')}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    if (event === 'notification' && payload?.data?.jobId === jobId) {
      res.write(`event: notification\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  try { bus.on(channel, listener); } catch {}

  const close = () => {
    clearInterval(ping);
    try { bus.off(channel, listener); } catch {}
    try { res.end(); } catch {}
    dbg('stream closed', { jobId, userId });
  };
  req.on('close', close);
  req.on('aborted', close);
};

exports.getJob = async (req, res) => {
  try {
    const doc = await DxfJob.findOne({ job_id: req.params.jobId }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // If we have stored blob paths, generate fresh SAS URLs for client consumption
    let result_sas_url = null;
    let svg_sas_url = null;
    try {
      if (doc.result_blob_url) {
        result_sas_url = await getReadSasUrl(doc.result_blob_url, {
          ttlSeconds: 3600,
          contentType: 'application/json',
          filename: `${doc.job_id}.json`
        });
      }
    } catch (e) {
      dbg('getJob SAS error (result)', { jobId: req.params.jobId, err: e?.message || String(e) });
    }
    try {
      if (doc.svg_blob_url) {
        svg_sas_url = await getReadSasUrl(doc.svg_blob_url, {
          ttlSeconds: 3600,
          contentType: 'image/svg+xml',
          filename: `${doc.job_id}.svg`
        });
      }
    } catch (e) {
      dbg('getJob SAS error (svg)', { jobId: req.params.jobId, err: e?.message || String(e) });
    }

    return res.json({
      ...doc,
      // expose fresh SAS urls alongside stored paths
      result_sas_url,
      svg_sas_url
    });
  } catch (e) {
    return res.status(500).json({ error: 'DB error', detail: String(e?.message || e) });
  }
};

/**
 * GET /api/dxf/jobs
 * List DXF jobs for the authenticated user.
 * Query:
 *  - status: queued|running|succeeded|failed (optional)
 *  - limit: number (default 50, max 200)
 *  - offset: number (default 0)
 *  - includeSas=1 to include short-lived SAS urls for succeeded items
 */
exports.listJobs = async (req, res) => {
  try {
    const userId = getUserId(req);
    const q = req.query || {};
    const status = typeof q.status === 'string' ? q.status.trim().toLowerCase() : null;

    const allowStatuses = new Set(['queued','running','succeeded','failed']);
    const filter = {
      owner_user_id: userId || null
    };
    if (status && allowStatuses.has(status)) {
      filter.status = status;
    }

    let limit = Number.parseInt(q.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(limit, 200);

    let offset = Number.parseInt(q.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const [total, docs] = await Promise.all([
      DxfJob.countDocuments(filter),
      DxfJob.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
    ]);

    const includeSas = q.includeSas === '1' || q.includeSas === 'true';

    // Optionally attach SAS urls for succeeded items that have blob paths
    let items = docs;
    if (includeSas) {
      items = await Promise.all(docs.map(async (d) => {
        let result_sas_url = null;
        let svg_sas_url = null;

        if (d.status === 'succeeded') {
          try {
            if (d.result_blob_url) {
              result_sas_url = await getReadSasUrl(d.result_blob_url, {
                ttlSeconds: 900,
                contentType: 'application/json',
                filename: `${d.job_id}.json`
              });
            }
          } catch (e) {
            dbg('listJobs SAS error (result)', { jobId: d.job_id, err: e?.message || String(e) });
          }
          try {
            if (d.svg_blob_url) {
              svg_sas_url = await getReadSasUrl(d.svg_blob_url, {
                ttlSeconds: 900,
                contentType: 'image/svg+xml',
                filename: `${d.job_id}.svg`
              });
            }
          } catch (e) {
            dbg('listJobs SAS error (svg)', { jobId: d.job_id, err: e?.message || String(e) });
          }
        }

        return {
          ...d,
          result_sas_url,
          svg_sas_url
        };
      }));
    }

    return res.json({
      items,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + items.length < total
      }
    });
  } catch (e) {
    dbg('listJobs error', { err: e?.message || String(e) });
    return res.status(500).json({ error: 'Failed to list jobs' });
  }
};

/**
 * DELETE /api/dxf/job/:jobId
 * Deletes a DXF job: removes blobs under dxf/<jobId>/ and deletes DB record.
 * Only the owner or an admin may delete.
 */
exports.deleteJob = async (req, res) => {
  const jobId = req.params.jobId;
  const requesterId = getUserId(req);

  dbg('deleteJob start', { jobId, requesterId });

  try {
    const doc = await DxfJob.findOne({ job_id: jobId }).lean();
    if (!doc) {
      dbg('deleteJob not found', { jobId });
      return res.status(404).json({ error: 'Not found' });
    }

    const ownerId = doc.owner_user_id || null;
    if (!(isAdmin(req) || (ownerId && requesterId && String(ownerId) === String(requesterId)))) {
      dbg('deleteJob forbidden', { jobId, requesterId, ownerId });
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Prefer deleting by prefix folder first (best effort)
    const folderPrefix = `dxf/${jobId}/`;
    try {
      await deletePrefix(folderPrefix);
      dbg('deleteJob prefix deleted', { prefix: folderPrefix });
    } catch (e) {
      console.warn('[dxf] deleteJob prefix error:', e?.message || e);
    }

    // Best-effort: if any stored blob paths are *outside* the canonical prefix, remove them individually.
    const paths = [doc.raw_blob_url, doc.result_blob_url, doc.svg_blob_url].filter(Boolean);
    for (const p of paths) {
      const pp = String(p);
      if (!pp.startsWith(folderPrefix)) {
        try {
          await deleteFile(pp);
          dbg('deleteJob extra path deleted', { path: pp });
        } catch (e) {
          console.warn('[dxf] deleteJob extra path delete error:', pp, e?.message || e);
        }
      }
    }

    // Stop any tracker if running
    try { stopTracker(jobId); } catch {}

    // Delete DB record
    await DxfJob.deleteOne({ job_id: jobId });

    dbg('deleteJob done', { jobId });
    return res.json({ deleted: true, jobId });
  } catch (e) {
    dbg('deleteJob error', { jobId, err: e?.message || String(e) });
    return res.status(500).json({ error: 'Delete failed', detail: e?.message || String(e) });
  }
};