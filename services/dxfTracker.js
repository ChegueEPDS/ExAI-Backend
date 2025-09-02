// services/dxfTracker.js
const owners = require('../owners');                // jobId -> userId
const bus = require('../bus');                      // user-specifikus emit
const { uploadBuffer } = require('../azureBlobService'); // feltételezzük: uploadBuffer(pathOrName, buffer, contentType) -> url
const DxfJob = require('../models/DxfJob');
const { notifyAndStore } = require('../notifier');  // ha nincs, cseréld bus.emit + saját mentésre

// ---- per-endpoint kulcsválasztó + URL builder (env alapján) ----
function pickFunctionCode(path = '') {
  const p = String(path);
  if (p.includes('/process_dxf/start'))  return process.env.DXF_FUNC_CODE_START  || process.env.DXF_FUNC_CODE || process.env.AZURE_FUNCTION_KEY;
  if (p.includes('/process_dxf/status')) return process.env.DXF_FUNC_CODE_STATUS || process.env.DXF_FUNC_CODE || process.env.AZURE_FUNCTION_KEY;
  if (p.includes('/process_dxf/result')) return process.env.DXF_FUNC_CODE_RESULT || process.env.DXF_FUNC_CODE || process.env.AZURE_FUNCTION_KEY;
  if (p.endsWith('/process_dxf') || p.includes('/process_dxf?'))
                                        return process.env.DXF_FUNC_CODE_SYNC   || process.env.DXF_FUNC_CODE || process.env.AZURE_FUNCTION_KEY;
  return process.env.DXF_FUNC_CODE || process.env.AZURE_FUNCTION_KEY || '';
}
function buildFunctionUrl(path = '/api/process_dxf') {
  const base = process.env.DXF_FUNC_URL || process.env.AZURE_FUNCTION_URL || 'http://localhost:7071';
  const root = new URL(base);
  const u = new URL(path, root);
  const code = pickFunctionCode(path);
  if (code && !u.searchParams.has('code')) u.searchParams.set('code', code);
  return u.toString();
}

// ---- fetch helper (timeout + retry) ----
async function fetchWithRetry(url, options = {}, { retries = 2, baseDelay = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 60_000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: controller.signal });
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
async function fetchJson(url, options = {}, retry = {}) {
  const resp = await fetchWithRetry(url, options, retry);
  const text = await resp.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { resp, text, json };
}

// ---- In-memory trackerek ----
const trackers = new Map();
/**
 * Elindít egy trackert a megadott jobId-hez.
 * - pollolja: /status, /result
 * - push: bus.emitTo(userId, 'dxf:status' | 'dxf:done' | 'dxf:error', payload)
 * - tartósítás: Blob + Mongo (DxfJob)
 */
function startTracker(jobId) {
  if (trackers.has(jobId)) return trackers.get(jobId);

  const pollMin = 1500, pollMax = 8000, jitter = 400;
  const t = { jobId, stopped: false, timer: null };

  async function tick(delay = pollMin) {
    if (t.stopped) return;
    clearTimeout(t.timer);

    try {
      // 1) status
      {
        const sBase = buildFunctionUrl('/api/process_dxf/status');
        const su = new URL(sBase);
        su.searchParams.set('job_id', jobId);

        const { resp, json } = await fetchJson(su.toString(), {
          headers: { Accept: 'application/json', Connection: 'close' },
          timeoutMs: 45_000
        }, { retries: 1, baseDelay: 400 });

        if (resp.ok && json?.status) {
          const userId = owners.get(jobId) || 'anonymous';
          bus.emitTo(userId, 'dxf:status', { jobId, status: json.status });
          // DB: running-ra frissítés (egyszerű, upsert)
          if (json.status === 'running') {
            DxfJob.updateOne({ job_id: jobId }, { $set: { status: 'running' } }).catch(()=>{});
          }
        }
      }

      // 2) result (409 = még nem kész)
      const rBase = buildFunctionUrl('/api/process_dxf/result');
      const ru = new URL(rBase);
      ru.searchParams.set('job_id', jobId);

      const rResp = await fetchWithRetry(ru.toString(), {
        headers: { Accept: 'application/json', Connection: 'close' },
        timeoutMs: 60_000
      }, { retries: 1, baseDelay: 600 });

      if (rResp.status === 409) {
        const next = Math.min(pollMax, Math.round(delay * 1.4)) + (Math.random()*jitter|0);
        t.timer = setTimeout(() => tick(next), next);
        return;
      }

      const rText = await rResp.text();
      let data; try { data = rText ? JSON.parse(rText) : undefined; } catch { data = undefined; }

      if (!rResp.ok || !data) {
        const userId = owners.get(jobId) || 'anonymous';
        const msg = (data?.error || rText || 'Azure Function hiba');
        bus.emitTo(userId, 'dxf:error', { jobId, message: msg });

        // DB fail + notification
        await DxfJob.updateOne(
          { job_id: jobId },
          { $set: { status: 'failed', error_message: msg, finished_at: new Date() } },
          { upsert: true }
        );
        await notifyAndStore(userId, {
          type: 'dxf-failed',
          title: 'DXF feldolgozás sikertelen',
          message: msg,
          data: { jobId }
        }).catch(()=>{});
        return stopTracker(jobId);
      }

      // ---- KÉSZ: tartós mentés Blobba + Mongo ----
      let resultUrl = null, svgUrl = null;

      try {
        const buf = Buffer.from(JSON.stringify(data), 'utf8');
        // saját azureBlobService implementációtól függően: itt egy egyszerű hívás
        resultUrl = await uploadBuffer(`dxf-result/${jobId}.json`, buf, 'application/json');
      } catch (e) { /* optional */ }

      if (data?.dxfSvg) {
        try {
          svgUrl = await uploadBuffer(`dxf-svg/${jobId}.svg`, Buffer.from(data.dxfSvg, 'utf8'), 'image/svg+xml');
        } catch (e) { /* optional */ }
      }

      const pipeCount    = Array.isArray(data.pipes) ? data.pipes.length : null;
      const groupCount   = Array.isArray(data.pipe_groups) ? data.pipe_groups.length : null;
      const fittingCount = Array.isArray(data.fittings) ? data.fittings.length : null;

      await DxfJob.updateOne(
        { job_id: jobId },
        {
          $set: {
            finished_at: new Date(),
            status: 'succeeded',
            error_message: null,
            result_blob_url: resultUrl,
            svg_blob_url: svgUrl,
            version: data?.version || 2,
            pipe_count: pipeCount,
            group_count: groupCount,
            fitting_count: fittingCount
          }
        },
        { upsert: true }
      );

      const userId = owners.get(jobId) || 'anonymous';
      bus.emitTo(userId, 'dxf:done', { jobId, result: data, blobs: { result: resultUrl, svg: svgUrl } });

      await notifyAndStore(userId, {
        type: 'dxf-done',
        title: 'DXF feldolgozás kész',
        message: data?.source?.filename || 'A feldolgozás befejeződött',
        data: { jobId, blobs: { result: resultUrl, svg: svgUrl } },
        meta: { route: '/dxf/view', query: { jobId } }
      }).catch(()=>{});

      stopTracker(jobId);
    } catch (e) {
      const next = Math.min(pollMax, Math.round(delay * 1.6)) + (Math.random()*jitter|0);
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

module.exports = { startTracker, stopTracker };